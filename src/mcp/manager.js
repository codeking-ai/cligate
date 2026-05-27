import { buildNamespacedMcpToolName, ensureUniqueMcpToolNames } from '../assistant-tools/mcp-service.js';
import mcpConfigStore, { sanitizeMcpServerConfig, validateMcpServerName } from './config-store.js';
import McpStdioClient from './stdio-client.js';
import McpStreamableHttpClient from './streamable-http-client.js';

function toText(value) {
  return String(value || '').trim();
}

function normalizeTool(serverName, tool = {}) {
  const toolName = toText(tool.name);
  return {
    serverName,
    toolName,
    namespacedToolName: buildNamespacedMcpToolName(serverName, toolName),
    description: toText(tool.description),
    inputSchema: tool.inputSchema || tool.input_schema || { type: 'object', properties: {} },
    annotations: tool.annotations || {}
  };
}

function createMcpClient(config = {}) {
  if (config.transport === 'stdio') {
    return new McpStdioClient(config);
  }
  if (config.transport === 'http') {
    return new McpStreamableHttpClient(config);
  }
  throw new Error(`Unsupported MCP transport: ${config.transport}`);
}

export class McpConnectionManager {
  constructor({ configStore = mcpConfigStore } = {}) {
    this.configStore = configStore;
    this.clients = new Map();
    this.toolCache = new Map();
    this.resourceCache = new Map();
    this.status = new Map();
    this.started = false;
  }

  async start() {
    this.started = true;
    await this.reloadAll();
  }

  async stop() {
    this.started = false;
    const closes = [...this.clients.values()].map((client) => client.close().catch(() => {}));
    this.clients.clear();
    this.toolCache.clear();
    this.resourceCache.clear();
    await Promise.all(closes);
  }

  hasEnabledServers() {
    return this.configStore.list({ includeSecrets: true }).some((entry) => entry.enabled === true);
  }

  async reloadAll() {
    const configs = this.configStore.list({ includeSecrets: true });
    const enabledNames = new Set(configs.filter((entry) => entry.enabled === true).map((entry) => entry.name));
    for (const [name, client] of this.clients.entries()) {
      if (!enabledNames.has(name)) {
        await client.close().catch(() => {});
        this.clients.delete(name);
        this.toolCache.delete(name);
        this.resourceCache.delete(name);
        this.status.set(name, { status: 'disabled', error: '' });
      }
    }
    for (const config of configs) {
      if (config.enabled === true) {
        await this.reloadServer(config.name).catch(() => {});
      } else if (!this.status.has(config.name)) {
        this.status.set(config.name, { status: 'disabled', error: '' });
      }
    }
  }

  async reloadServer(name) {
    const config = this.configStore.get(name, { includeSecrets: true });
    if (!config) throw new Error(`MCP server not found: ${name}`);
    const normalizedName = validateMcpServerName(config.name);
    const existing = this.clients.get(normalizedName);
    if (existing) {
      await existing.close().catch(() => {});
      this.clients.delete(normalizedName);
    }
    this.toolCache.delete(normalizedName);
    this.resourceCache.delete(normalizedName);

    if (config.enabled !== true) {
      this.status.set(normalizedName, { status: 'disabled', error: '' });
      return this.getServerSnapshot(normalizedName);
    }
    const client = createMcpClient(config);
    this.attachClientListeners(normalizedName, client);
    this.clients.set(normalizedName, client);
    this.status.set(normalizedName, { status: 'starting', error: '' });
    try {
      await client.connect();
      const tools = await client.listTools().catch(() => []);
      this.toolCache.set(normalizedName, tools);
      const listedResources = await client.listResources().catch(() => ({ resources: [], nextCursor: null }));
      this.resourceCache.set(normalizedName, listedResources.resources || []);
      this.status.set(normalizedName, { status: 'connected', error: '' });
    } catch (error) {
      this.status.set(normalizedName, { status: 'failed', error: error.message || 'MCP connection failed' });
      await client.close().catch(() => {});
      this.clients.delete(normalizedName);
    }
    return this.getServerSnapshot(normalizedName);
  }

  attachClientListeners(name, client) {
    client.on?.('notification', (message) => {
      const method = toText(message?.method);
      if (method === 'notifications/tools/list_changed') {
        this.refreshServerTools(name).catch((error) => {
          this.status.set(name, { status: 'connected', error: error.message || 'MCP tools refresh failed' });
        });
      }
      if (method === 'notifications/resources/list_changed') {
        this.refreshServerResources(name).catch((error) => {
          this.status.set(name, { status: 'connected', error: error.message || 'MCP resources refresh failed' });
        });
      }
    });
    client.on?.('stream_error', (error) => {
      const current = this.status.get(name) || { status: 'connected', error: '' };
      this.status.set(name, {
        ...current,
        error: error?.message || 'MCP HTTP stream failed'
      });
    });
  }

  async enableServer(name, enabled) {
    const updated = this.configStore.setEnabled(name, enabled === true);
    await this.reloadServer(updated.name);
    return this.getServerSnapshot(updated.name);
  }

  async upsertServer(input = {}) {
    const updated = this.configStore.upsert(input);
    await this.reloadServer(updated.name);
    return this.getServerSnapshot(updated.name);
  }

  async removeServer(name) {
    const normalizedName = validateMcpServerName(name);
    const client = this.clients.get(normalizedName);
    if (client) await client.close().catch(() => {});
    this.clients.delete(normalizedName);
    this.toolCache.delete(normalizedName);
    this.resourceCache.delete(normalizedName);
    this.status.delete(normalizedName);
    return this.configStore.remove(normalizedName);
  }

  listServers() {
    return this.configStore.list().map((config) => this.getServerSnapshot(config.name));
  }

  getServerSnapshot(name) {
    const config = this.configStore.get(name) || { name };
    const status = this.status.get(config.name) || { status: config.enabled ? 'stopped' : 'disabled', error: '' };
    const client = this.clients.get(config.name);
    const clientSnapshot = client?.snapshot?.() || {};
    return {
      ...sanitizeMcpServerConfig(config),
      status: clientSnapshot.status || status.status,
      error: clientSnapshot.error || status.error || '',
      toolCount: (this.toolCache.get(config.name) || []).length,
      resourceCount: (this.resourceCache.get(config.name) || []).length,
      serverInfo: clientSnapshot.serverInfo || null
    };
  }

  requireConnectedClient(serverName) {
    const name = validateMcpServerName(serverName);
    const client = this.clients.get(name);
    if (!client || client.status !== 'connected') {
      const status = this.status.get(name);
      throw new Error(`MCP server is not connected: ${name}${status?.error ? ` (${status.error})` : ''}`);
    }
    return { name, client };
  }

  async refreshServerTools(serverName) {
    const { name, client } = this.requireConnectedClient(serverName);
    const tools = await client.listTools();
    this.toolCache.set(name, tools);
    return tools;
  }

  async refreshServerResources(serverName) {
    const { name, client } = this.requireConnectedClient(serverName);
    const listedResources = await client.listResources();
    this.resourceCache.set(name, listedResources.resources || []);
    return listedResources.resources || [];
  }

  listTools({ serverName = '' } = {}) {
    const name = validateMcpServerName(serverName);
    const tools = this.toolCache.get(name) || [];
    return ensureUniqueMcpToolNames(tools.map((tool) => normalizeTool(name, tool)));
  }

  listResources({ serverName = '', cursor = '' } = {}) {
    const name = validateMcpServerName(serverName);
    const resources = this.resourceCache.get(name) || [];
    const offset = Number.parseInt(cursor, 10);
    const start = Number.isFinite(offset) ? Math.max(0, offset) : 0;
    const slice = resources.slice(start, start + 100);
    return {
      serverName: name,
      resources: slice,
      nextCursor: start + slice.length < resources.length ? String(start + slice.length) : null
    };
  }

  async readResource({ serverName = '', uri = '' } = {}) {
    const { client } = this.requireConnectedClient(serverName);
    return client.readResource(uri);
  }

  async callTool({ serverName = '', toolName = '', arguments: args = {}, metadata = {} } = {}) {
    const { name, client } = this.requireConnectedClient(serverName);
    const tools = this.toolCache.get(name) || [];
    const tool = tools.find((entry) => toText(entry.name) === toText(toolName));
    if (!tool) {
      throw new Error(`MCP tool not found: ${name}/${toolName}`);
    }
    return client.callTool(toolName, args, metadata);
  }
}

export const mcpConnectionManager = new McpConnectionManager();

export default mcpConnectionManager;
