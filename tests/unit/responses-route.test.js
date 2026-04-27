import test from 'node:test';
import assert from 'node:assert/strict';

import { _testExports } from '../../src/routes/responses-route.js';
import { orderAssignedCredentials } from '../../src/app-routing.js';
import { setCredentialRuntimeState } from '../../src/runtime-state.js';

const {
  _responsesToChatBody,
  findToolCallSequenceError,
  resolveResponsesStreamingMode,
  _responsesToAnthropicBody,
  getAssignedFailureReason,
  normalizeAssignedFailureReason
} = _testExports;

test('_responsesToChatBody merges assistant text before function_call into one tool-calling assistant message', () => {
  const parsed = {
    model: 'gpt-5.4',
    input: [
      { type: 'message', role: 'user', content: 'check repo' },
      { type: 'message', role: 'assistant', content: 'I will inspect files first.' },
      { type: 'function_call', call_id: 'call_1', name: 'shell_command', arguments: '{"command":"Get-ChildItem"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file list' }
    ]
  };

  const body = _responsesToChatBody(parsed);

  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[1].role, 'assistant');
  assert.equal(body.messages[1].content, 'I will inspect files first.');
  assert.equal(body.messages[1].tool_calls[0].id, 'call_1');
  assert.equal(body.messages[2].role, 'tool');
  assert.equal(body.messages[2].tool_call_id, 'call_1');
  assert.equal(findToolCallSequenceError(body.messages), null);
});

test('_responsesToChatBody merges assistant text after function_call into the same tool-calling assistant message', () => {
  const parsed = {
    model: 'gpt-5.4',
    input: [
      { type: 'message', role: 'user', content: 'check repo' },
      { type: 'function_call', call_id: 'call_2', name: 'shell_command', arguments: '{"command":"git status"}' },
      { type: 'message', role: 'assistant', content: 'I am checking the working tree.' },
      { type: 'function_call_output', call_id: 'call_2', output: 'clean' }
    ]
  };

  const body = _responsesToChatBody(parsed);

  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[1].role, 'assistant');
  assert.equal(body.messages[1].content, 'I am checking the working tree.');
  assert.equal(body.messages[1].tool_calls[0].id, 'call_2');
  assert.equal(body.messages[2].role, 'tool');
  assert.equal(body.messages[2].tool_call_id, 'call_2');
  assert.equal(findToolCallSequenceError(body.messages), null);
});

test('_responsesToChatBody defers system messages inserted between tool_calls and tool outputs', () => {
  const parsed = {
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

  const body = _responsesToChatBody(parsed);

  assert.equal(body.messages.length, 4);
  assert.equal(body.messages[1].role, 'assistant');
  assert.equal(body.messages[1].tool_calls[0].id, 'call_3');
  assert.equal(body.messages[2].role, 'tool');
  assert.equal(body.messages[2].tool_call_id, 'call_3');
  assert.equal(body.messages[3].role, 'system');
  assert.match(body.messages[3].content, /Approved command prefix saved/);
  assert.equal(findToolCallSequenceError(body.messages), null);
});

test('findToolCallSequenceError detects assistant tool_calls not followed by tool messages', () => {
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

test('_responsesToChatBody preserves antigravity model id for route dispatch', () => {
  const parsed = {
    model: 'antigravity/gemini-2.5-pro',
    input: [
      { type: 'message', role: 'user', content: 'check routing' }
    ]
  };

  const body = _responsesToChatBody(parsed);

  assert.equal(body.model, 'antigravity/gemini-2.5-pro');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
});

test('resolveResponsesStreamingMode disables streaming for compact requests', () => {
  assert.equal(resolveResponsesStreamingMode(true, { stream: true }), false);
  assert.equal(resolveResponsesStreamingMode(true, { stream: false }), false);
  assert.equal(resolveResponsesStreamingMode(true, null), false);
});

test('resolveResponsesStreamingMode preserves normal responses streaming behavior', () => {
  assert.equal(resolveResponsesStreamingMode(false, { stream: true }), true);
  assert.equal(resolveResponsesStreamingMode(false, { stream: false }), false);
  assert.equal(resolveResponsesStreamingMode(false, null), true);
});

test('_responsesToAnthropicBody normalizes top-level union tool schemas for Claude', () => {
  const body = _responsesToAnthropicBody({
    model: 'gpt-5.4',
    input: [{ type: 'message', role: 'user', content: 'click browser element' }],
    tools: [{
      type: 'function',
      name: 'browser_click',
      description: 'Click an element',
      parameters: {
        oneOf: [
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

test('orderAssignedCredentials keeps assigned bindings stable for sequential strategy', () => {
  const assignments = [
    { credential: { email: 'a@example.com' } },
    { credential: { email: 'b@example.com' } },
    { credential: { email: 'c@example.com' } }
  ];

  const ordered = orderAssignedCredentials(assignments, 'sequential', () => 0.99);

  assert.deepEqual(
    ordered.map((item) => item.credential.email),
    ['a@example.com', 'b@example.com', 'c@example.com']
  );
  assert.notEqual(ordered, assignments);
});

test('orderAssignedCredentials shuffles assigned bindings for random strategy', () => {
  const assignments = [
    { credential: { email: 'a@example.com' } },
    { credential: { email: 'b@example.com' } },
    { credential: { email: 'c@example.com' } }
  ];

  const randomValues = [0.8, 0.1];
  const ordered = orderAssignedCredentials(assignments, 'random', () => randomValues.shift() ?? 0);

  assert.deepEqual(
    ordered.map((item) => item.credential.email),
    ['b@example.com', 'a@example.com', 'c@example.com']
  );
  assert.deepEqual(
    assignments.map((item) => item.credential.email),
    ['a@example.com', 'b@example.com', 'c@example.com']
  );
});

test('normalizeAssignedFailureReason falls back when value is empty', () => {
  assert.equal(normalizeAssignedFailureReason('', 'request_failed'), 'request_failed');
  assert.equal(normalizeAssignedFailureReason(' auth_error_403 ', 'request_failed'), 'auth_error_403');
});

test('getAssignedFailureReason prefers assigned credential runtime error state', () => {
  const credentialId = 'api-key:key_assigned_runtime';
  setCredentialRuntimeState(credentialId, {
    status: 'invalid',
    lastError: 'auth_error_403'
  });

  const reason = getAssignedFailureReason({
    unavailableReason: 'request_failed',
    assignments: [
      {
        credentialType: 'api-key',
        credential: { id: 'key_assigned_runtime' },
        binding: { targetId: 'key_assigned_runtime' }
      }
    ]
  });

  assert.equal(reason, 'auth_error_403');

  setCredentialRuntimeState(credentialId, {
    status: 'active',
    lastError: null
  });
});

test('getAssignedFailureReason surfaces per-request upstream errors over the misleading "resolved" reason', () => {
  // Simulates the DeepSeek 400 case: app-routing sets unavailableReason='resolved'
  // (success-path label) but the assigned API key handler captured the real
  // upstream HTTP error onto assignment.upstreamErrors before returning false.
  const reason = getAssignedFailureReason({
    unavailableReason: 'resolved',
    assignments: [
      {
        credentialType: 'api-key',
        credential: { id: 'key_deepseek' },
        binding: { targetId: 'key_deepseek' }
      }
    ],
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

test('getAssignedFailureReason picks the most recent upstream error when multiple candidates fail', () => {
  const reason = getAssignedFailureReason({
    unavailableReason: 'resolved',
    upstreamErrors: [
      { provider: 'openai', status: 401, message: 'invalid_api_key' },
      { provider: 'deepseek', status: 503, message: 'service_unavailable' }
    ]
  });

  assert.equal(reason, 'deepseek_503: service_unavailable');
});
