import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleChatWithSource, handleConfirmAssistantToolAction } from '../../src/routes/chat-ui-route.js';
import { createPendingAssistantAction } from '../../src/assistant/tool-executor.js';

function mockRes() {
  return {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; }
  };
}

function mockReq(body = {}) {
  return {
    body,
    app: { locals: { port: 8081 } },
    socket: { localPort: 8081 }
  };
}

test('handleChatWithSource returns a pending action for Claude proxy enable requests in assistant mode', async () => {
  const req = mockReq({
    sourceId: 'chatgpt:test@example.com',
    model: 'gpt-5.2',
    assistantMode: true,
    uiLang: 'zh',
    messages: [
      { role: 'user', content: '帮我设置 Claude Code 使用代理' }
    ]
  });
  const res = mockRes();

  await handleChatWithSource(req, res);

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.reply.role, 'assistant');
  assert.equal(res._body.assistant.intent, 'tool_request');
  assert.equal(res._body.reply.pendingAction.toolName, 'enable_claude_code_proxy');
  assert.ok(res._body.reply.pendingAction.confirmToken);
});

test('handleConfirmAssistantToolAction validates missing confirm token', async () => {
  const req = mockReq({});
  const res = mockRes();

  await handleConfirmAssistantToolAction(req, res);

  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
});

test('handleConfirmAssistantToolAction executes pending Claude proxy action against temp config path', async () => {
  const originalConfigPath = process.env.CLAUDE_CONFIG_PATH;
  const tempConfigDir = mkdtempSync(join(tmpdir(), 'cligate-claude-config-'));
  process.env.CLAUDE_CONFIG_PATH = tempConfigDir;

  try {
    const pendingAction = createPendingAssistantAction('enable_claude_code_proxy', {
      language: 'en',
      port: 8081
    });

    const req = mockReq({
      confirmToken: pendingAction.confirmToken
    });
    const res = mockRes();

    await handleConfirmAssistantToolAction(req, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.match(res._body.result, /proxy mode/i);
    assert.ok(res._body.configPath.endsWith('settings.json'));

    const persisted = JSON.parse(readFileSync(res._body.configPath, 'utf8'));
    assert.equal(persisted.env.ANTHROPIC_BASE_URL, 'http://localhost:8081');
    assert.equal(persisted.env.ANTHROPIC_API_KEY, 'sk-ant-claude-code-proxy');
  } finally {
    if (originalConfigPath === undefined) {
      delete process.env.CLAUDE_CONFIG_PATH;
    } else {
      process.env.CLAUDE_CONFIG_PATH = originalConfigPath;
    }
  }
});
