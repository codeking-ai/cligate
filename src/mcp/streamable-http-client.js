import { EventEmitter } from 'events';

function nowIso() {
  return new Date().toISOString();
}

function normalizeJsonRpcError(error = {}) {
  const message = error?.message || 'MCP JSON-RPC error';
  const next = new Error(message);
  next.code = error?.code;
  next.data = error?.data;
  return next;
}

function normalizeHeaders(value = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function contentTypeOf(response) {
  return String(response?.headers?.get?.('content-type') || '').toLowerCase();
}

function timeoutMsOf(config = {}) {
  return Number(config.timeoutMs || 30000);
}

function createTimeoutController(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
    }
  };
}

function createAbortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

async function readStreamChunk(reader, signal, timeoutMs = 0) {
  if (signal?.aborted) {
    throw createAbortError();
  }
  if (!signal && !timeoutMs) {
    return reader.read();
  }
  let abortHandler = null;
  let deadlineTimer = null;
  const aborted = new Promise((resolve, reject) => {
    const abort = () => {
      reject(createAbortError());
      reader.cancel().catch(() => {});
    };
    abortHandler = abort;
    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    if (timeoutMs > 0) {
      deadlineTimer = setTimeout(abort, timeoutMs);
    }
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (abortHandler) {
      signal?.removeEventListener('abort', abortHandler);
    }
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }
  }
}

async function readResponseText(response, { signal = null, deadlineAt = 0 } = {}) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    return response.text();
  }
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const timeoutMs = deadlineAt > 0 ? Math.max(0, deadlineAt - Date.now()) : 0;
    const { value, done } = await readStreamChunk(reader, signal, timeoutMs);
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function parseSseChunk(buffer = '') {
  const events = [];
  let rest = buffer;
  while (true) {
    const marker = rest.indexOf('\n\n');
    const crlfMarker = rest.indexOf('\r\n\r\n');
    const end = marker >= 0 && (crlfMarker < 0 || marker < crlfMarker)
      ? marker
      : crlfMarker;
    if (end < 0) break;
    const raw = rest.slice(0, end);
    rest = rest.slice(end + (rest.startsWith('\r\n\r\n', end) ? 4 : 2));
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (data) events.push(data);
  }
  return { events, rest };
}

export class McpStreamableHttpClient extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.nextId = 1;
    this.status = 'stopped';
    this.error = '';
    this.startedAt = null;
    this.serverInfo = null;
    this.sessionId = '';
    this.streamController = null;
    this.streamPromise = null;
  }

  async connect() {
    if (this.status === 'connected') return;
    if (!this.config.url) {
      throw new Error('streamable HTTP MCP server URL is required');
    }
    this.status = 'starting';
    this.error = '';
    this.startedAt = nowIso();
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
    if (this.sessionId) {
      await this.notify('notifications/initialized', {});
    }
    this.status = 'connected';
    this.openServerStream().catch(() => {});
  }

  async close() {
    this.status = 'stopped';
    this.error = '';
    if (this.streamController) {
      this.streamController.abort();
      this.streamController = null;
    }
  }

  buildHeaders(extra = {}) {
    const bearerTokenEnvVar = String(this.config.bearerTokenEnvVar || '').trim();
    const bearerToken = bearerTokenEnvVar ? String(process.env[bearerTokenEnvVar] || '').trim() : '';
    const headers = {
      Accept: 'application/json, text/event-stream',
      ...normalizeHeaders(this.config.headers),
      ...extra
    };
    if (bearerToken && !headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${bearerToken}`;
    }
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }
    return headers;
  }

  rememberSession(response) {
    const sessionId = String(response?.headers?.get?.('mcp-session-id') || '').trim();
    if (sessionId) {
      this.sessionId = sessionId;
    }
  }

  async fetchJsonRpc(message, { expectResponse = true } = {}) {
    const timeoutMs = timeoutMsOf(this.config);
    const deadlineAt = Date.now() + timeoutMs;
    const controller = createTimeoutController(timeoutMs);
    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: this.buildHeaders({
          'Content-Type': 'application/json'
        }),
        body: JSON.stringify(message),
        signal: controller.signal
      });

      this.rememberSession(response);
      if (!response.ok) {
        const text = await readResponseText(response, {
          signal: controller.signal,
          deadlineAt
        }).catch(() => '');
        throw new Error(`MCP HTTP request failed with ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
      }
      if (!expectResponse || response.status === 202) {
        return null;
      }

      const contentType = contentTypeOf(response);
      if (contentType.includes('text/event-stream')) {
        return await this.readSseResponse(response, message.id, {
          signal: controller.signal,
          deadlineAt
        });
      }
      const payload = JSON.parse(await readResponseText(response, {
        signal: controller.signal,
        deadlineAt
      }));
      return this.handleResponseMessage(payload);
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`MCP HTTP request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      controller.clear();
    }
  }

  handleResponseMessage(message) {
    if (message?.error) {
      throw normalizeJsonRpcError(message.error);
    }
    if (message?.method && message.id === undefined) {
      this.emit('notification', message);
      return null;
    }
    return message?.result ?? null;
  }

  async readSseResponse(response, requestId, { signal = null, deadlineAt = 0 } = {}) {
    const reader = response.body?.getReader?.();
    if (!reader) {
      throw new Error('MCP HTTP SSE response is not readable');
    }
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const timeoutMs = deadlineAt > 0 ? Math.max(0, deadlineAt - Date.now()) : 0;
      const { value, done } = await readStreamChunk(reader, signal, timeoutMs);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseChunk(buffer);
      buffer = parsed.rest;
      for (const data of parsed.events) {
        let message = null;
        try {
          message = JSON.parse(data);
        } catch {
          continue;
        }
        if (message?.id === requestId) {
          return this.handleResponseMessage(message);
        }
        this.emit('notification', message);
      }
    }
    throw new Error('MCP HTTP SSE response ended before matching JSON-RPC response');
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return this.fetchJsonRpc({
      jsonrpc: '2.0',
      id,
      method,
      params
    });
  }

  async notify(method, params = {}) {
    await this.fetchJsonRpc({
      jsonrpc: '2.0',
      method,
      params
    }, {
      expectResponse: false
    });
  }

  async openServerStream() {
    if (!this.sessionId || this.streamPromise || this.status === 'stopped') return;
    const controller = new AbortController();
    this.streamController = controller;
    this.streamPromise = this.readServerStream(controller.signal)
      .catch((error) => {
        if (this.status !== 'stopped') {
          this.emit('stream_error', error);
        }
      })
      .finally(() => {
        if (this.streamController === controller) {
          this.streamController = null;
        }
        this.streamPromise = null;
      });
  }

  async readServerStream(signal) {
    const response = await fetch(this.config.url, {
      method: 'GET',
      headers: this.buildHeaders({
        Accept: 'text/event-stream'
      }),
      signal
    });
    this.rememberSession(response);
    if (!response.ok || !contentTypeOf(response).includes('text/event-stream')) {
      return;
    }
    const reader = response.body?.getReader?.();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    while (this.status !== 'stopped') {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseChunk(buffer);
      buffer = parsed.rest;
      for (const data of parsed.events) {
        let message = null;
        try {
          message = JSON.parse(data);
        } catch {
          continue;
        }
        this.emit('notification', message);
      }
    }
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
      serverInfo: this.serverInfo,
      sessionId: this.sessionId || ''
    };
  }
}

export default McpStreamableHttpClient;
