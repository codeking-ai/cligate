import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';

export const MCP_CONFIG_FILE = join(CONFIG_DIR, 'mcp', 'servers.json');

function nowIso() {
  return new Date().toISOString();
}

function toText(value) {
  return String(value || '').trim();
}

export function validateMcpServerName(value) {
  const name = toText(value);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('MCP server name must contain only letters, numbers, underscore, or hyphen');
  }
  return name;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry)).filter((entry) => entry.length > 0);
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function isSensitiveKey(key = '') {
  return /authorization|api[_-]?key|token|secret|password|cookie/i.test(String(key || ''));
}

function redactObject(value = {}) {
  const out = {};
  for (const [key, entry] of Object.entries(normalizeObject(value))) {
    out[key] = isSensitiveKey(key)
      ? '[redacted]'
      : entry;
  }
  return out;
}

function mergeRedactedObject(input = {}, previous = {}) {
  const out = normalizeObject(input);
  const old = normalizeObject(previous);
  for (const [key, value] of Object.entries(out)) {
    if (value === '[redacted]' && isSensitiveKey(key) && old[key] !== undefined) {
      out[key] = old[key];
    }
  }
  return out;
}

export function normalizeMcpServerConfig(input = {}, previous = null) {
  const name = validateMcpServerName(input.name || previous?.name);
  const transport = toText(input.transport || previous?.transport || 'stdio').toLowerCase();
  if (!['stdio', 'http'].includes(transport)) {
    throw new Error('MCP transport must be stdio or http');
  }
  const enabled = input.enabled !== undefined ? input.enabled === true : previous?.enabled === true;
  const command = toText(input.command ?? previous?.command);
  const url = toText(input.url ?? previous?.url);
  if (enabled && transport === 'stdio' && !command) {
    throw new Error('MCP stdio command is required');
  }
  if (enabled && transport === 'http' && !url) {
    throw new Error('MCP HTTP URL is required');
  }

  const now = nowIso();
  return {
    name,
    enabled,
    transport,
    command,
    args: normalizeStringArray(input.args ?? previous?.args),
    cwd: toText(input.cwd ?? previous?.cwd),
    env: input.env !== undefined
      ? mergeRedactedObject(input.env, previous?.env)
      : normalizeObject(previous?.env),
    url,
    bearerTokenEnvVar: toText(input.bearerTokenEnvVar ?? previous?.bearerTokenEnvVar),
    headers: input.headers !== undefined
      ? mergeRedactedObject(input.headers, previous?.headers)
      : normalizeObject(previous?.headers),
    timeoutMs: Math.min(120000, Math.max(1000, Number(input.timeoutMs ?? previous?.timeoutMs ?? 30000) || 30000)),
    approvalMode: ['ask', 'always', 'never'].includes(toText(input.approvalMode ?? previous?.approvalMode))
      ? toText(input.approvalMode ?? previous?.approvalMode)
      : 'ask',
    createdAt: previous?.createdAt || now,
    updatedAt: now
  };
}

export function sanitizeMcpServerConfig(config = {}) {
  return {
    ...config,
    env: redactObject(config.env),
    headers: redactObject(config.headers)
  };
}

export class McpConfigStore {
  constructor({ file = MCP_CONFIG_FILE } = {}) {
    this.file = file;
    this.data = null;
  }

  ensureDir() {
    const dir = dirname(this.file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  load() {
    if (this.data) return this.data;
    this.ensureDir();
    if (!existsSync(this.file)) {
      this.data = { version: 1, servers: [] };
      return this.data;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      this.data = {
        version: 1,
        servers: Array.isArray(parsed?.servers)
          ? parsed.servers.map((entry) => {
              try {
                return normalizeMcpServerConfig(entry);
              } catch {
                return null;
              }
            }).filter(Boolean)
          : []
      };
    } catch {
      this.data = { version: 1, servers: [] };
    }
    return this.data;
  }

  saveData(data = this.load()) {
    this.ensureDir();
    this.data = {
      version: 1,
      servers: Array.isArray(data.servers) ? data.servers : []
    };
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    return this.data;
  }

  list({ includeSecrets = false } = {}) {
    const servers = this.load().servers;
    return includeSecrets ? [...servers] : servers.map((entry) => sanitizeMcpServerConfig(entry));
  }

  get(name, { includeSecrets = false } = {}) {
    const normalizedName = validateMcpServerName(name);
    const server = this.load().servers.find((entry) => entry.name === normalizedName) || null;
    if (!server) return null;
    return includeSecrets ? server : sanitizeMcpServerConfig(server);
  }

  upsert(input = {}) {
    const data = this.load();
    const name = validateMcpServerName(input.name);
    const index = data.servers.findIndex((entry) => entry.name === name);
    const previous = index >= 0 ? data.servers[index] : null;
    const next = normalizeMcpServerConfig(input, previous);
    if (index >= 0) {
      data.servers[index] = next;
    } else {
      data.servers.push(next);
    }
    data.servers.sort((left, right) => left.name.localeCompare(right.name));
    this.saveData(data);
    return sanitizeMcpServerConfig(next);
  }

  remove(name) {
    const normalizedName = validateMcpServerName(name);
    const data = this.load();
    const before = data.servers.length;
    data.servers = data.servers.filter((entry) => entry.name !== normalizedName);
    this.saveData(data);
    return data.servers.length !== before;
  }

  setEnabled(name, enabled) {
    const server = this.get(name, { includeSecrets: true });
    if (!server) {
      throw new Error(`MCP server not found: ${name}`);
    }
    return this.upsert({
      ...server,
      enabled: enabled === true
    });
  }
}

export const mcpConfigStore = new McpConfigStore();

export default mcpConfigStore;
