import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';

function nowIso() {
  return new Date().toISOString();
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalizeJsonRpcError(error = {}) {
  const message = error?.message || 'MCP JSON-RPC error';
  const next = new Error(message);
  next.code = error?.code;
  next.data = error?.data;
  return next;
}

export class McpStdioClient extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.process = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.lineBuffer = '';
    this.decoder = new StringDecoder('utf8');
    this.status = 'stopped';
    this.error = '';
    this.startedAt = null;
    this.serverInfo = null;
  }

  async connect() {
    if (this.status === 'connected') return;
    if (!this.config.command) {
      throw new Error('stdio MCP server command is required');
    }
    this.status = 'starting';
    this.error = '';
    this.startedAt = nowIso();
    const env = {
      ...process.env,
      ...(this.config.env || {})
    };
    this.process = spawn(this.config.command, this.config.args || [], {
      cwd: this.config.cwd || process.cwd(),
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process.stdout.on('data', (chunk) => this.handleData(chunk));
    this.process.stderr.on('data', (chunk) => {
      const text = this.decoder.write(chunk).trim();
      if (text) this.emit('stderr', text);
    });
    this.process.on('error', (error) => {
      this.status = 'failed';
      this.error = error.message || 'MCP process failed';
      this.rejectAll(error);
    });
    this.process.on('exit', (code, signal) => {
      if (this.status !== 'stopped') {
        this.status = code === 0 ? 'stopped' : 'failed';
        this.error = code === 0 ? '' : `MCP process exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`;
      }
      this.rejectAll(new Error(this.error || 'MCP process exited'));
    });

    const init = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {
        roots: { listChanged: false },
        sampling: {}
      },
      clientInfo: {
        name: 'cligate',
        version: '1.2.2'
      }
    });
    this.serverInfo = init?.serverInfo || null;
    this.notify('notifications/initialized', {});
    this.status = 'connected';
  }

  async close() {
    this.status = 'stopped';
    this.error = '';
    this.rejectAll(new Error('MCP client closed'));
    if (this.process) {
      const child = this.process;
      this.process = null;
      child.kill();
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  handleData(chunk) {
    if (this.buffer.length > 0) {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.handleFramedData();
      return;
    }
    const text = chunk.toString('utf8');
    this.lineBuffer += text;
    while (true) {
      const newlineIndex = this.lineBuffer.indexOf('\n');
      if (newlineIndex < 0) break;
      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      if (line.toLowerCase().startsWith('content-length:')) {
        this.buffer = Buffer.from(`${line}\r\n${this.lineBuffer}`, 'utf8');
        this.lineBuffer = '';
        this.handleFramedData();
        return;
      }
      try {
        this.handleMessage(JSON.parse(line));
      } catch {
        this.emit('stderr', line);
      }
    }
  }

  handleFramedData() {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString('utf8');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = Buffer.alloc(0);
        this.status = 'failed';
        this.error = 'Invalid MCP response header';
        this.rejectAll(new Error(this.error));
        return;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.slice(bodyStart, bodyEnd).toString('utf8');
      this.buffer = this.buffer.slice(bodyEnd);
      let message = null;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message?.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(normalizeJsonRpcError(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    this.emit('notification', message);
  }

  send(message) {
    if (!this.process?.stdin?.writable) {
      throw new Error('MCP stdio process is not writable');
    }
    const body = JSON.stringify(message);
    this.process.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const timeoutMs = Number(this.config.timeoutMs || 30000);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({
        jsonrpc: '2.0',
        id,
        method,
        params
      });
    });
    return withTimeout(promise, timeoutMs + 250, `MCP request ${method}`);
  }

  notify(method, params = {}) {
    this.send({
      jsonrpc: '2.0',
      method,
      params
    });
  }

  async listTools() {
    const result = await this.request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args = {}, metadata = {}) {
    return this.request('tools/call', {
      name,
      arguments: args,
      _meta: metadata
    });
  }

  async listResources(cursor = '') {
    const result = await this.request('resources/list', cursor ? { cursor } : {});
    return {
      resources: Array.isArray(result?.resources) ? result.resources : [],
      nextCursor: result?.nextCursor || null
    };
  }

  async readResource(uri = '') {
    return this.request('resources/read', { uri });
  }

  snapshot() {
    return {
      status: this.status,
      error: this.error,
      startedAt: this.startedAt,
      serverInfo: this.serverInfo
    };
  }
}

export default McpStdioClient;
