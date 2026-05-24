function normalizeText(value) {
  return String(value || '').trim();
}

function validateServerName(value) {
  const name = normalizeText(value);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`invalid MCP server name: ${value}`);
  }
  return name;
}

export function buildNamespacedMcpToolName(serverName, toolName) {
  return `mcp__${validateServerName(serverName)}__${normalizeText(toolName)}`;
}

export function parseNamespacedMcpToolName(value) {
  const text = normalizeText(value);
  const match = /^mcp__([a-zA-Z0-9_-]+)__(.+)$/.exec(text);
  if (!match) {
    return null;
  }
  return {
    serverName: match[1],
    toolName: match[2]
  };
}

export class AssistantMcpService {
  constructor({
    servers = [],
    resources = {},
    toolResultFactory = null
  } = {}) {
    this.servers = new Map();
    for (const server of servers) {
      const name = validateServerName(server?.name);
      this.servers.set(name, {
        name,
        tools: Array.isArray(server?.tools) ? server.tools : [],
        resources: Array.isArray(server?.resources) ? server.resources : []
      });
    }
    this.resources = new Map(Object.entries(resources));
    this.toolResultFactory = typeof toolResultFactory === 'function'
      ? toolResultFactory
      : null;
  }

  listServers() {
    return [...this.servers.values()].map((server) => ({
      name: server.name,
      toolCount: server.tools.length,
      resourceCount: server.resources.length
    }));
  }

  listTools({ serverName = '' } = {}) {
    const server = this._requireServer(serverName);
    return server.tools.map((tool) => ({
      serverName: server.name,
      toolName: normalizeText(tool?.name),
      namespacedToolName: buildNamespacedMcpToolName(server.name, tool?.name),
      description: normalizeText(tool?.description),
      inputSchema: tool?.inputSchema || { type: 'object', properties: {} }
    }));
  }

  listResources({ serverName = '', cursor = '' } = {}) {
    const server = this._requireServer(serverName);
    const offset = Number.parseInt(cursor, 10);
    const start = Number.isFinite(offset) ? Math.max(0, offset) : 0;
    const slice = server.resources.slice(start, start + 100);
    const nextCursor = start + slice.length < server.resources.length
      ? String(start + slice.length)
      : null;
    return {
      serverName: server.name,
      resources: slice,
      nextCursor
    };
  }

  readResource({ serverName = '', uri = '' } = {}) {
    const server = this._requireServer(serverName);
    const key = `${server.name}:${normalizeText(uri)}`;
    if (!this.resources.has(key)) {
      throw new Error(`MCP resource not found: ${uri}`);
    }
    return this.resources.get(key);
  }

  callTool({ serverName = '', toolName = '', arguments: args = {}, metadata = {} } = {}) {
    const server = this._requireServer(serverName);
    const tool = server.tools.find((entry) => normalizeText(entry?.name) === normalizeText(toolName));
    if (!tool) {
      throw new Error(`MCP tool not found: ${server.name}/${toolName}`);
    }
    if (this.toolResultFactory) {
      return this.toolResultFactory({
        serverName: server.name,
        toolName: normalizeText(toolName),
        arguments: args,
        metadata
      });
    }
    return {
      serverName: server.name,
      toolName: normalizeText(toolName),
      arguments: args,
      content: [{
        type: 'text',
        text: `Stub MCP result for ${server.name}/${normalizeText(toolName)}`
      }]
    };
  }

  _requireServer(serverName = '') {
    const name = validateServerName(serverName);
    const server = this.servers.get(name);
    if (!server) {
      throw new Error(`MCP server not found: ${serverName}`);
    }
    return server;
  }
}

export default AssistantMcpService;
