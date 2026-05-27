import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpConfigStore, McpConnectionManager, McpStdioClient, McpStreamableHttpClient } from '../../src/mcp/index.js';
import { AssistantMcpService, createBuiltinAssistantToolRegistry } from '../../src/assistant-tools/index.js';
import AssistantDialogueService from '../../src/assistant-agent/dialogue-service.js';

function parseFramedJson(message) {
  const text = String(message || '');
  const separator = text.indexOf('\r\n\r\n');
  assert.ok(separator > 0);
  const header = text.slice(0, separator);
  const match = /content-length:\s*(\d+)/i.exec(header);
  assert.ok(match);
  const body = text.slice(separator + 4);
  assert.equal(Buffer.byteLength(body, 'utf8'), Number(match[1]));
  return JSON.parse(body);
}

function createStore() {
  return new McpConfigStore({
    file: join(mkdtempSync(join(tmpdir(), 'cligate-mcp-test-')), 'servers.json')
  });
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : null);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function createHttpMcpServer({
  sseToolsList = false,
  hangingSseToolsList = false,
  requiredAuthorization = '',
  sessionId = 'session-1'
} = {}) {
  const seen = [];
  const openResponses = new Set();
  const server = http.createServer(async (req, res) => {
    res.on('close', () => {
      openResponses.delete(res);
    });
    if (req.method === 'GET') {
      if (requiredAuthorization && req.headers.authorization !== requiredAuthorization) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      });
      res.write('event: message\n');
      res.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed","params":{}}\n\n');
      res.end();
      return;
    }
    const message = await readRequestJson(req);
    seen.push({
      method: message?.method,
      sessionId: req.headers['mcp-session-id'] || '',
      authorization: req.headers.authorization || ''
    });
    if (requiredAuthorization && req.headers.authorization !== requiredAuthorization) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const headers = {
      'Content-Type': (sseToolsList || hangingSseToolsList) && message?.method === 'tools/list' ? 'text/event-stream' : 'application/json',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
    };
    if (message?.method === 'notifications/initialized') {
      res.writeHead(202, headers);
      res.end();
      return;
    }
    let result = {};
    if (message?.method === 'initialize') {
      result = { serverInfo: { name: 'http-test' } };
    } else if (message?.method === 'tools/list') {
      result = {
        tools: [{
          name: 'search',
          description: 'Search over HTTP',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
        }]
      };
    } else if (message?.method === 'tools/call') {
      result = {
        content: [{ type: 'text', text: `called:${message?.params?.name}:${message?.params?.arguments?.query || ''}` }]
      };
    } else if (message?.method === 'resources/list') {
      result = { resources: [{ uri: 'docs://intro', name: 'Intro' }] };
    } else if (message?.method === 'resources/read') {
      result = { contents: [{ uri: message?.params?.uri, mimeType: 'text/plain', text: 'hello' }] };
    }
    const response = { jsonrpc: '2.0', id: message?.id, result };
    res.writeHead(200, headers);
    if (hangingSseToolsList && message?.method === 'tools/list') {
      openResponses.add(res);
      res.write('event: message\n');
      res.write('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n');
      return;
    }
    if (sseToolsList && message?.method === 'tools/list') {
      res.write(`data: ${JSON.stringify(response)}\n\n`);
      res.end();
      return;
    }
    res.end(JSON.stringify(response));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    seen,
    close: () => new Promise((resolve) => {
      for (const response of openResponses) {
        response.destroy();
      }
      server.close(resolve);
    })
  };
}

test('McpConnectionManager saves disabled servers without connecting or exposing tools', async () => {
  const store = createStore();
  const manager = new McpConnectionManager({ configStore: store });

  const server = await manager.upsertServer({
    name: 'docs',
    enabled: false,
    transport: 'stdio',
    command: 'node',
    args: ['server.js']
  });

  assert.equal(server.name, 'docs');
  assert.equal(server.enabled, false);
  assert.equal(server.status, 'disabled');
  assert.equal(manager.hasEnabledServers(), false);
  assert.deepEqual(manager.listTools({ serverName: 'docs' }), []);
});

test('McpConfigStore preserves redacted secrets when updating a server from UI payloads', () => {
  const store = createStore();

  store.upsert({
    name: 'docs',
    enabled: false,
    transport: 'stdio',
    command: 'node',
    env: {
      API_TOKEN: 'real-token',
      DEBUG: '1'
    },
    headers: {
      Authorization: 'Bearer real',
      Trace: 'on'
    }
  });

  const sanitized = store.get('docs');
  assert.equal(sanitized.env.API_TOKEN, '[redacted]');
  assert.equal(sanitized.headers.Authorization, '[redacted]');

  store.upsert({
    ...sanitized,
    command: 'node2',
    env: {
      ...sanitized.env,
      DEBUG: '0'
    },
    headers: {
      ...sanitized.headers,
      Trace: 'off'
    }
  });

  const saved = store.get('docs', { includeSecrets: true });
  assert.equal(saved.command, 'node2');
  assert.equal(saved.env.API_TOKEN, 'real-token');
  assert.equal(saved.env.DEBUG, '0');
  assert.equal(saved.headers.Authorization, 'Bearer real');
  assert.equal(saved.headers.Trace, 'off');
});

test('McpConfigStore validates enabled transport requirements while allowing disabled drafts', () => {
  const store = createStore();

  const draft = store.upsert({
    name: 'remote_docs',
    enabled: false,
    transport: 'http',
    bearerTokenEnvVar: 'REMOTE_DOCS_TOKEN'
  });
  assert.equal(draft.transport, 'http');
  assert.equal(draft.enabled, false);
  assert.equal(draft.bearerTokenEnvVar, 'REMOTE_DOCS_TOKEN');

  assert.throws(() => store.upsert({
    name: 'remote_docs',
    enabled: true,
    transport: 'http'
  }), /HTTP URL is required/);
});

test('assistant builtin tools omit MCP tools until an MCP service is mounted', () => {
  const withoutMcp = createBuiltinAssistantToolRegistry({
    workspaceRoot: process.cwd()
  }).registry.list();

  const withMcp = createBuiltinAssistantToolRegistry({
    workspaceRoot: process.cwd(),
    mcpService: {
      listServers() { return []; },
      listTools() { return []; },
      listResources() { return { resources: [], nextCursor: null }; },
      readResource() { return {}; },
      callTool() { return {}; }
    }
  }).registry.list();

  assert.equal(withoutMcp.some((tool) => tool.name === 'call_mcp_tool'), false);
  assert.equal(withMcp.some((tool) => tool.name === 'call_mcp_tool'), true);
});

test('assistant builtin tools expose discovered MCP tools as direct namespaced tools', () => {
  const tools = createBuiltinAssistantToolRegistry({
    workspaceRoot: process.cwd(),
    mcpService: {
      listServers() { return [{ name: 'docs' }]; },
      listTools() {
        return [{
          serverName: 'docs',
          toolName: 'search docs',
          namespacedToolName: 'mcp__docs__search_docs',
          description: 'Search docs',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query']
          }
        }];
      },
      listResources() { return { resources: [], nextCursor: null }; },
      readResource() { return {}; },
      callTool() { return {}; }
    }
  }).registry.list();

  const direct = tools.find((tool) => tool.name === 'mcp__docs__search_docs');
  assert.equal(direct?.source, 'mcp');
  assert.equal(direct?.metadata?.mcp?.serverName, 'docs');
  assert.equal(direct?.metadata?.mcp?.toolName, 'search docs');
  assert.equal(direct?.inputSchema?.required[0], 'query');
});

test('MCP namespaced tool names are sanitized, length-limited, and uniqued', () => {
  const mcpService = new AssistantMcpService({
    servers: [{
      name: 'docs',
      tools: [
        { name: 'search docs' },
        { name: 'search/docs' },
        { name: `very ${'long '.repeat(20)}tool name` }
      ]
    }]
  });

  const tools = mcpService.listTools({ serverName: 'docs' });
  const names = tools.map((tool) => tool.namespacedToolName);
  assert.equal(names.length, new Set(names).size);
  assert.ok(names.every((name) => /^[a-zA-Z0-9_-]+$/.test(name)));
  assert.ok(names.every((name) => name.length <= 64));
  assert.equal(tools[0].toolName, 'search docs');
  assert.equal(tools[1].toolName, 'search/docs');
});

test('McpStdioClient parses framed JSON-RPC responses across chunks', async () => {
  const client = new McpStdioClient({ command: 'node', timeoutMs: 1000 });
  const writes = [];
  client.process = {
    stdin: {
      writable: true,
      write(message) {
        writes.push(message);
      }
    }
  };

  const pending = client.request('tools/list', {});
  const sent = parseFramedJson(writes[0]);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: sent.id,
    result: {
      tools: [{ name: 'search' }]
    }
  });
  const framed = Buffer.from(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`, 'utf8');

  client.handleData(framed.slice(0, 10));
  client.handleData(framed.slice(10, 31));
  client.handleData(framed.slice(31));

  assert.deepEqual(await pending, {
    tools: [{ name: 'search' }]
  });
});

test('McpStdioClient sends stdio requests with standard Content-Length framing', () => {
  const client = new McpStdioClient({ command: 'node', timeoutMs: 1000 });
  const writes = [];
  client.process = {
    stdin: {
      writable: true,
      write(message) {
        writes.push(message);
      }
    }
  };

  client.notify('notifications/initialized', {});

  const sent = parseFramedJson(writes[0]);
  assert.equal(sent.jsonrpc, '2.0');
  assert.equal(sent.method, 'notifications/initialized');
});

test('McpStreamableHttpClient connects, reuses session id, and handles JSON responses', async () => {
  const server = await createHttpMcpServer();
  try {
    const client = new McpStreamableHttpClient({
      url: server.url,
      timeoutMs: 2000
    });

    await client.connect();
    assert.equal(client.status, 'connected');
    assert.equal(client.sessionId, 'session-1');
    assert.deepEqual(client.serverInfo, { name: 'http-test' });

    const tools = await client.listTools();
    assert.equal(tools[0].name, 'search');
    const result = await client.callTool('search', { query: 'hello' });
    assert.equal(result.content[0].text, 'called:search:hello');

    assert.equal(server.seen.find((entry) => entry.method === 'tools/list')?.sessionId, 'session-1');
    await client.close();
  } finally {
    await server.close();
  }
});

test('McpStreamableHttpClient skips initialized notification for stateless HTTP servers', async () => {
  const server = await createHttpMcpServer({ sessionId: '' });
  try {
    const client = new McpStreamableHttpClient({
      url: server.url,
      timeoutMs: 2000
    });

    await client.connect();
    assert.equal(client.status, 'connected');
    assert.equal(client.sessionId, '');
    assert.equal(server.seen.some((entry) => entry.method === 'notifications/initialized'), false);

    const tools = await client.listTools();
    assert.equal(tools[0].name, 'search');
    await client.close();
  } finally {
    await server.close();
  }
});

test('McpStreamableHttpClient handles SSE JSON-RPC responses', async () => {
  const server = await createHttpMcpServer({ sseToolsList: true });
  try {
    const client = new McpStreamableHttpClient({
      url: server.url,
      timeoutMs: 2000
    });

    await client.connect();
    const tools = await client.listTools();
    assert.equal(tools[0].name, 'search');
    await client.close();
  } finally {
    await server.close();
  }
});

test('McpStreamableHttpClient times out SSE JSON-RPC responses after headers', async () => {
  const server = await createHttpMcpServer({ hangingSseToolsList: true });
  try {
    const client = new McpStreamableHttpClient({
      url: server.url,
      timeoutMs: 50
    });

    await client.connect();
    await assert.rejects(
      () => client.listTools(),
      /MCP HTTP request timed out after 50ms/
    );
    await client.close();
  } finally {
    await server.close();
  }
});

test('McpStreamableHttpClient sends configured Authorization headers', async () => {
  const server = await createHttpMcpServer({ requiredAuthorization: 'Bearer test-token' });
  try {
    const client = new McpStreamableHttpClient({
      url: server.url,
      timeoutMs: 2000,
      headers: {
        Authorization: 'Bearer test-token'
      }
    });

    await client.connect();
    await client.listTools();
    assert.ok(server.seen.every((entry) => entry.authorization === 'Bearer test-token'));
    await client.close();
  } finally {
    await server.close();
  }
});

test('McpStreamableHttpClient can build bearer Authorization from an env var', async () => {
  const server = await createHttpMcpServer({ requiredAuthorization: 'Bearer env-token' });
  const previous = process.env.CLIGATE_TEST_MCP_TOKEN;
  process.env.CLIGATE_TEST_MCP_TOKEN = 'env-token';
  try {
    const client = new McpStreamableHttpClient({
      url: server.url,
      timeoutMs: 2000,
      bearerTokenEnvVar: 'CLIGATE_TEST_MCP_TOKEN'
    });

    await client.connect();
    await client.listTools();
    assert.ok(server.seen.every((entry) => entry.authorization === 'Bearer env-token'));
    await client.close();
  } finally {
    if (previous === undefined) {
      delete process.env.CLIGATE_TEST_MCP_TOKEN;
    } else {
      process.env.CLIGATE_TEST_MCP_TOKEN = previous;
    }
    await server.close();
  }
});

test('McpConnectionManager connects enabled streamable HTTP servers', async () => {
  const server = await createHttpMcpServer();
  const store = createStore();
  const manager = new McpConnectionManager({ configStore: store });
  try {
    const snapshot = await manager.upsertServer({
      name: 'http_docs',
      enabled: true,
      transport: 'http',
      url: server.url,
      timeoutMs: 2000
    });

    assert.equal(snapshot.status, 'connected');
    assert.equal(snapshot.toolCount, 1);
    assert.equal(manager.listTools({ serverName: 'http_docs' })[0].namespacedToolName, 'mcp__http_docs__search');
    const called = await manager.callTool({
      serverName: 'http_docs',
      toolName: 'search',
      arguments: { query: 'manager' }
    });
    assert.equal(called.content[0].text, 'called:search:manager');
  } finally {
    await manager.stop();
    await server.close();
  }
});

test('AssistantDialogueService remounts MCP tools when resolver output changes', () => {
  let enabled = false;
  const mcpService = {
    listServers() { return [{ name: 'docs' }]; },
    listTools() { return []; },
    listResources() { return { resources: [], nextCursor: null }; },
    readResource() { return {}; },
    callTool() { return {}; }
  };
  const dialogueService = new AssistantDialogueService({
    runStore: { save(run) { return run; } },
    observationService: {
      getWorkspaceContext() { return {}; },
      getConversationContext() { return {}; }
    },
    taskViewService: {
      listTasks() { return []; },
      getConversationTaskSpace() { return {}; }
    },
    messageService: {},
    enableBuiltinExecutionTools: true,
    llmClient: { async hasAvailableSource() { return true; } },
    executionMcpServiceResolver() {
      return enabled ? mcpService : null;
    }
  });

  assert.equal(dialogueService.executionToolRegistry.get('list_mcp_servers'), null);
  enabled = true;
  dialogueService.refreshExecutionSurfaceForCwd(process.cwd());
  assert.ok(dialogueService.executionToolRegistry.get('list_mcp_servers'));
});
