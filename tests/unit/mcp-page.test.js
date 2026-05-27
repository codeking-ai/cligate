import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMcpPageModule } from '../../public/js/modules/mcp-page.js';

function createHarness(overrides = {}) {
  return {
    ...createMcpPageModule(),
    t(key) {
      return key;
    },
    showToast() {},
    api: async () => ({ ok: false, data: null }),
    ...overrides
  };
}

test('MCP page builds STDIO payload without HTTP-only fields', () => {
  const app = createHarness();
  app.mcpForm = {
    ...app.mcpForm,
    name: 'filesystem',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    argsText: '--yes\n@modelcontextprotocol/server-filesystem\nD:\\workspace',
    cwd: 'D:\\workspace',
    envText: '{"NODE_ENV":"production"}',
    url: 'https://stale.example/mcp',
    bearerTokenEnvVar: 'STALE_TOKEN',
    headersText: '{"Authorization":"Bearer stale"}',
    timeoutMs: 45000
  };

  const payload = app.buildMcpPayload();

  assert.equal(payload.transport, 'stdio');
  assert.equal(payload.command, 'npx');
  assert.deepEqual(payload.args, ['--yes', '@modelcontextprotocol/server-filesystem', 'D:\\workspace']);
  assert.deepEqual(payload.env, { NODE_ENV: 'production' });
  assert.equal(payload.url, '');
  assert.equal(payload.bearerTokenEnvVar, '');
  assert.deepEqual(payload.headers, {});
  assert.equal(app.validateMcpPayload(payload), '');
});

test('MCP page builds Streamable HTTP payload without STDIO-only fields', () => {
  const app = createHarness();
  app.mcpForm = {
    ...app.mcpForm,
    name: 'remote_docs',
    enabled: true,
    transport: 'http',
    command: 'stale-command',
    argsText: 'stale-arg',
    cwd: 'D:\\stale',
    envText: '{"STALE":"1"}',
    url: 'https://example.com/mcp',
    bearerTokenEnvVar: 'MCP_TOKEN',
    headersText: '{"X-Client":"cligate"}',
    timeoutMs: 30000
  };

  const payload = app.buildMcpPayload();

  assert.equal(payload.transport, 'http');
  assert.equal(payload.command, '');
  assert.deepEqual(payload.args, []);
  assert.equal(payload.cwd, '');
  assert.deepEqual(payload.env, {});
  assert.equal(payload.url, 'https://example.com/mcp');
  assert.equal(payload.bearerTokenEnvVar, 'MCP_TOKEN');
  assert.deepEqual(payload.headers, { 'X-Client': 'cligate' });
  assert.equal(app.validateMcpPayload(payload), '');
});

test('MCP page validates transport-specific required fields and URL protocol', () => {
  const app = createHarness();

  assert.equal(app.validateMcpPayload({
    name: 'bad_stdio',
    transport: 'stdio',
    command: '',
    timeoutMs: 30000
  }), 'mcpCommandRequired');

  assert.equal(app.validateMcpPayload({
    name: 'bad_http',
    transport: 'http',
    url: '',
    timeoutMs: 30000
  }), 'mcpUrlRequired');

  assert.equal(app.validateMcpPayload({
    name: 'bad_http',
    transport: 'http',
    url: 'file:///tmp/mcp.sock',
    timeoutMs: 30000
  }), 'mcpUrlInvalid');
});

test('MCP page summarizes server transport endpoints for the inventory', () => {
  const app = createHarness();

  assert.equal(app.mcpTransportLabel('http'), 'mcpTransportHttp');
  assert.equal(app.mcpTransportLabel('stdio'), 'mcpTransportStdio');
  assert.equal(app.mcpServerSummary({
    transport: 'http',
    url: 'https://example.com/mcp'
  }), 'https://example.com/mcp');
  assert.equal(app.mcpServerSummary({
    transport: 'stdio',
    command: 'npx',
    args: ['--yes', '@modelcontextprotocol/server-filesystem']
  }), 'npx --yes @modelcontextprotocol/server-filesystem');
});

test('MCP partial uses dedicated stable layout classes', () => {
  const html = readFileSync(join(process.cwd(), 'public', 'partials', 'views', 'mcp.html'), 'utf8');

  assert.match(html, /class="mcp-page"/);
  assert.match(html, /class="mcp-layout"/);
  assert.doesNotMatch(html, /\b(?:sm|md|lg|xl|2xl):/);
  assert.doesNotMatch(html, /grid-cols-\[/);
});
