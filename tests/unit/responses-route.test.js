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
  _chatToResponsesFormat,
  buildNativeResponsesForwardHeaders,
  copyAllowedResponseHeaders,
  getAssignedFailureReason,
  normalizeAssignedFailureReason
} = _testExports;

test('buildNativeResponsesForwardHeaders keeps Codex lineage and turn headers for native responses providers', () => {
  const headers = buildNativeResponsesForwardHeaders({
    'x-client-request-id': 'thread-1',
    'session_id': 'thread-1',
    'x-codex-turn-state': 'ts-1',
    'x-openai-subagent': 'review',
    'x-codex-window-id': 'thread-1:0',
    'x-codex-parent-thread-id': 'parent-1',
    'x-codex-turn-metadata': '{"turn_id":"turn-1"}',
    'x-codex-installation-id': 'install-1',
    'x-codex-beta-features': 'responses_websockets',
    'x-responsesapi-include-timing-metrics': 'true',
    'openai-beta': 'assistants=v2',
    'x-ignored-header': 'nope'
  });

  assert.deepEqual(headers, {
    'x-client-request-id': 'thread-1',
    'session_id': 'thread-1',
    'x-codex-turn-state': 'ts-1',
    'x-openai-subagent': 'review',
    'x-codex-window-id': 'thread-1:0',
    'x-codex-parent-thread-id': 'parent-1',
    'x-codex-turn-metadata': '{"turn_id":"turn-1"}',
    'x-codex-installation-id': 'install-1',
    'x-codex-beta-features': 'responses_websockets',
    'x-responsesapi-include-timing-metrics': 'true',
    'openai-beta': 'assistants=v2'
  });
});

test('copyAllowedResponseHeaders writes turn-state and model headers back to downstream client', () => {
  const upstream = new Response('{}', {
    status: 200,
    headers: {
      'x-codex-turn-state': 'ts-2',
      'openai-model': 'gpt-5.4',
      'x-openai-model': 'gpt-5.4',
      'x-reasoning-included': 'true',
      'x-ignored-header': 'nope'
    }
  });

  const written = new Map();
  const res = {
    setHeader(name, value) {
      written.set(String(name), value);
    }
  };

  copyAllowedResponseHeaders(upstream, res);

  assert.equal(written.get('x-codex-turn-state'), 'ts-2');
  assert.equal(written.get('openai-model'), 'gpt-5.4');
  assert.equal(written.get('x-openai-model'), 'gpt-5.4');
  assert.equal(written.get('x-reasoning-included'), 'true');
  assert.equal(written.has('x-ignored-header'), false);
});

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

test('_responsesToChatBody reattaches reasoning items onto the following assistant message for DeepSeek tool turns', () => {
  const parsed = {
    model: 'deepseek-v4-flash',
    input: [
      { type: 'message', role: 'user', content: 'inspect repo' },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'Need to inspect files before answering.' }]
      },
      { type: 'message', role: 'assistant', content: 'I will inspect the repository first.' },
      { type: 'function_call', call_id: 'call_1', name: 'shell_command', arguments: '{"command":"Get-ChildItem"}' }
    ]
  };

  const body = _responsesToChatBody(parsed);

  assert.equal(body.messages[1].role, 'assistant');
  assert.equal(body.messages[1].reasoning_content, 'Need to inspect files before answering.');
  assert.equal(body.messages[1].tool_calls[0].id, 'call_1');
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

test('_chatToResponsesFormat emits a reasoning output item when reasoning_content is present (DeepSeek thinking)', () => {
  const chatResponse = {
    id: 'cmpl_test',
    choices: [{
      message: {
        role: 'assistant',
        content: 'Here is the answer.',
        reasoning_content: 'Let me think step by step about this problem.'
      }
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
  };

  const result = _chatToResponsesFormat(chatResponse, 'gpt-5.4');

  assert.ok(Array.isArray(result.output));
  assert.equal(result.output[0].type, 'reasoning');
  assert.equal(result.output[0].summary[0].type, 'summary_text');
  assert.equal(result.output[0].summary[0].text, 'Let me think step by step about this problem.');
  // The text message comes after the reasoning item
  assert.equal(result.output[1].type, 'message');
  assert.equal(result.output[1].content[0].text, 'Here is the answer.');
});

test('_chatToResponsesFormat does not emit reasoning when the field is absent (no impact on OpenAI/Azure)', () => {
  const chatResponse = {
    id: 'cmpl_test',
    choices: [{
      message: {
        role: 'assistant',
        content: 'plain reply'
      }
    }]
  };

  const result = _chatToResponsesFormat(chatResponse, 'gpt-5.4');

  // No reasoning items in output — only the regular message
  const reasoningItems = result.output.filter(o => o.type === 'reasoning');
  assert.equal(reasoningItems.length, 0);
  assert.equal(result.output[0].type, 'message');
});

test('_chatToResponsesFormat emits reasoning + message + function_call together when all three are present', () => {
  const chatResponse = {
    choices: [{
      message: {
        role: 'assistant',
        content: 'Calling tool now',
        reasoning_content: 'I should look up the file first',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"foo"}' }
        }]
      }
    }]
  };

  const result = _chatToResponsesFormat(chatResponse, 'gpt-5.4');

  assert.equal(result.output.length, 3);
  assert.equal(result.output[0].type, 'reasoning');
  assert.equal(result.output[1].type, 'message');
  assert.equal(result.output[2].type, 'function_call');
});
