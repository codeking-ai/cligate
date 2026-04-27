import test from 'node:test';
import assert from 'node:assert/strict';

import { _testExports } from '../../src/routes/codex-route.js';
import { setCredentialRuntimeState } from '../../src/runtime-state.js';

const {
  _codexToChatBody,
  _codexToAnthropicBody,
  findToolCallSequenceError,
  getAssignedFailureReason,
  normalizeAssignedFailureReason
} = _testExports;

test('_codexToChatBody merges assistant text before function_call into one tool-calling assistant message', () => {
  const body = {
    model: 'gpt-5.4',
    input: [
      { type: 'message', role: 'user', content: 'check repo' },
      { type: 'message', role: 'assistant', content: 'I will inspect files first.' },
      { type: 'function_call', call_id: 'call_1', name: 'shell_command', arguments: '{"command":"Get-ChildItem"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file list' }
    ]
  };

  const chatBody = _codexToChatBody(body);

  assert.equal(chatBody.messages.length, 3);
  assert.equal(chatBody.messages[1].role, 'assistant');
  assert.equal(chatBody.messages[1].content, 'I will inspect files first.');
  assert.equal(chatBody.messages[1].tool_calls[0].id, 'call_1');
  assert.equal(chatBody.messages[2].role, 'tool');
  assert.equal(chatBody.messages[2].tool_call_id, 'call_1');
  assert.equal(findToolCallSequenceError(chatBody.messages), null);
});

test('_codexToChatBody defers system messages inserted between tool_calls and tool outputs', () => {
  const body = {
    model: 'gpt-5.4',
    input: [
      { type: 'message', role: 'user', content: 'verify config migration' },
      {
        type: 'message',
        role: 'assistant',
        content: 'I need to write back the old value once to verify migration.'
      },
      {
        type: 'function_call',
        call_id: 'call_3',
        name: 'shell_command',
        arguments: '{"command":"pwsh -Command ..."}'
      },
      {
        type: 'message',
        role: 'developer',
        content: 'Approved command prefix saved: [pwsh, -Command, node ...]'
      },
      {
        type: 'function_call_output',
        call_id: 'call_3',
        output: '{"afterSticky":"sequential"}'
      }
    ]
  };

  const chatBody = _codexToChatBody(body);

  assert.equal(chatBody.messages.length, 4);
  assert.equal(chatBody.messages[1].role, 'assistant');
  assert.equal(chatBody.messages[1].tool_calls[0].id, 'call_3');
  assert.equal(chatBody.messages[2].role, 'tool');
  assert.equal(chatBody.messages[2].tool_call_id, 'call_3');
  assert.equal(chatBody.messages[3].role, 'system');
  assert.match(chatBody.messages[3].content, /Approved command prefix saved/);
  assert.equal(findToolCallSequenceError(chatBody.messages), null);
});

test('findToolCallSequenceError detects assistant tool_calls not followed by tool messages in codex route', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'running tool',
      tool_calls: [
        {
          id: 'call_missing',
          type: 'function',
          function: { name: 'shell_command', arguments: '{}' }
        }
      ]
    },
    { role: 'assistant', content: 'unexpected extra assistant message' }
  ];

  const error = findToolCallSequenceError(messages);

  assert.ok(error);
  assert.equal(error.assistantIndex, 1);
  assert.deepEqual(error.missingIds, ['call_missing']);
  assert.equal(error.nextRole, 'assistant');
});

test('_codexToChatBody keeps antigravity model id untouched for downstream mapping', () => {
  const body = {
    model: 'antigravity/gemini-2.5-pro',
    input: [
      { type: 'message', role: 'user', content: 'hello' }
    ]
  };

  const chatBody = _codexToChatBody(body);

  assert.equal(chatBody.model, 'antigravity/gemini-2.5-pro');
  assert.equal(chatBody.messages.length, 1);
  assert.equal(chatBody.messages[0].role, 'user');
});

test('codex route test exports remain available after strict compatibility changes', () => {
  assert.equal(typeof _codexToChatBody, 'function');
  assert.equal(typeof _codexToAnthropicBody, 'function');
  assert.equal(typeof findToolCallSequenceError, 'function');
});

test('_codexToAnthropicBody normalizes top-level union tool schemas for Claude', () => {
  const body = _codexToAnthropicBody({
    model: 'gpt-5.4',
    input: [{ type: 'message', role: 'user', content: 'click browser element' }],
    tools: [{
      type: 'function',
      name: 'browser_click',
      description: 'Click an element',
      parameters: {
        anyOf: [
          {
            type: 'object',
            properties: {
              selector: { type: 'string' }
            },
            required: ['selector']
          },
          {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' }
            },
            required: ['x', 'y']
          }
        ]
      }
    }]
  });

  assert.equal(body.tools[0].input_schema.type, 'object');
  assert.equal(body.tools[0].input_schema.oneOf, undefined);
  assert.equal(body.tools[0].input_schema.anyOf, undefined);
  assert.equal(body.tools[0].input_schema.allOf, undefined);
});

test('codex normalizeAssignedFailureReason falls back when value is empty', () => {
  assert.equal(normalizeAssignedFailureReason('', 'request_failed'), 'request_failed');
  assert.equal(normalizeAssignedFailureReason(' auth_error_401 ', 'request_failed'), 'auth_error_401');
});

test('codex getAssignedFailureReason prefers assigned credential runtime error state', () => {
  const credentialId = 'api-key:key_codex_assigned_runtime';
  setCredentialRuntimeState(credentialId, {
    status: 'invalid',
    lastError: 'auth_error_401'
  });

  const reason = getAssignedFailureReason({
    unavailableReason: 'request_failed',
    assignments: [
      {
        credentialType: 'api-key',
        credential: { id: 'key_codex_assigned_runtime' },
        binding: { targetId: 'key_codex_assigned_runtime' }
      }
    ]
  });

  assert.equal(reason, 'auth_error_401');

  setCredentialRuntimeState(credentialId, {
    status: 'active',
    lastError: null
  });
});

test('codex getAssignedFailureReason surfaces per-request upstream errors over the "resolved" placeholder', () => {
  const reason = getAssignedFailureReason({
    unavailableReason: 'resolved',
    upstreamErrors: [
      {
        provider: 'deepseek',
        keyId: 'key_deepseek',
        status: 400,
        message: 'The `reasoning_content` in the thinking mode must be passed back to the API.'
      }
    ]
  });

  assert.match(reason, /^deepseek_400:/);
  assert.match(reason, /reasoning_content/);
});
