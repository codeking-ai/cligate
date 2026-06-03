import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPendingActionInvocations,
  ensurePendingAssistantAction
} from '../../src/assistant-core/pending-action-resolver.js';
import { resolveAssistantConfirmation } from '../../src/assistant-core/assistant-confirmation-service.js';
import { AssistantPendingActionStore } from '../../src/assistant-core/pending-action-store.js';

// Mirrors the real stored shape of a requires-approval tool result in
// run.metadata.toolResults (see react-engine.js): structured lives under
// `result`, with kind=policy_block + requiresApproval/requiresConfirmation.
function policyBlockResult(toolName, input) {
  return {
    toolName,
    input,
    status: 'requires_approval',
    success: false,
    summary: 'Tool call requires approval: mutating_tool_requires_confirmation',
    result: {
      kind: 'policy_block',
      toolName,
      reason: 'mutating_tool_requires_confirmation',
      requiresApproval: true,
      requiresConfirmation: true
    },
    metadata: {}
  };
}

test('buildPendingActionInvocations returns every batched tool call', () => {
  const action = {
    toolName: 'send_message_to_channel',
    input: { text: '1' },
    metadata: {
      batch: [
        { toolName: 'send_message_to_channel', input: { text: '1' } },
        { toolName: 'send_message_to_channel', input: { text: '2' } },
        { toolName: 'send_message_to_channel', input: { text: '3' } }
      ]
    }
  };
  const invs = buildPendingActionInvocations(action);
  assert.equal(invs.length, 3);
  assert.deepEqual(invs.map((i) => i.input.text), ['1', '2', '3']);
});

test('buildPendingActionInvocations falls back to the single action when there is no batch', () => {
  const invs = buildPendingActionInvocations({ toolName: 'x', input: { a: 1 }, metadata: {} });
  assert.equal(invs.length, 1);
  assert.equal(invs[0].toolName, 'x');
  assert.deepEqual(invs[0].input, { a: 1 });
});

test('ensurePendingAssistantAction captures ALL confirmation-required tool calls into metadata.batch', () => {
  // Regression for the DingTalk image-send incident: a run that batched 5 sends
  // recorded only the FIRST as the pending action (.find()), so the other 4 were
  // silently dropped and the user got the same first image re-sent each approve.
  const pendingActionStore = new AssistantPendingActionStore();
  const run = {
    id: 'run-1',
    status: 'waiting_user',
    triggerText: '继续发送，直到完成所有图片的发送',
    metadata: {
      stopPolicy: { reason: 'assistant_confirmation_required' },
      toolResults: [
        policyBlockResult('send_message_to_channel', { text: '图片 1/5', imagePath: 'D:\\git.png' }),
        policyBlockResult('send_message_to_channel', { text: '图片 2/5', imagePath: 'D:\\github.jpg' }),
        policyBlockResult('send_message_to_channel', { text: '图片 3/5', imagePath: 'D:\\postman.png' })
      ]
    }
  };
  const runStore = { get: (id) => (id === 'run-1' ? run : null) };
  const conversation = { id: 'conv-1', metadata: { assistantCore: { lastRunId: 'run-1' } } };

  const action = ensurePendingAssistantAction(conversation, {
    runStore,
    pendingActionStore,
    conversationStore: null
  });

  assert.ok(action, 'should build a pending action');
  assert.equal(action.toolName, 'send_message_to_channel', 'first tool preserved for back-compat');
  assert.ok(Array.isArray(action.metadata.batch), 'metadata.batch is an array');
  assert.equal(action.metadata.batch.length, 3, 'captures all 3 sends, not just the first');
  assert.deepEqual(
    action.metadata.batch.map((b) => b.input.imagePath),
    ['D:\\git.png', 'D:\\github.jpg', 'D:\\postman.png']
  );
});

test('resolveAssistantConfirmation executes the WHOLE batch on a single approve', async () => {
  const pendingActionStore = new AssistantPendingActionStore();
  const created = pendingActionStore.create({
    conversationId: 'conv-1',
    assistantRunId: 'run-1',
    toolName: 'send_message_to_channel',
    input: { text: '图片 1/5', imagePath: 'D:\\git.png' },
    metadata: {
      batch: [
        { toolName: 'send_message_to_channel', input: { imagePath: 'D:\\git.png' } },
        { toolName: 'send_message_to_channel', input: { imagePath: 'D:\\github.jpg' } },
        { toolName: 'send_message_to_channel', input: { imagePath: 'D:\\postman.png' } }
      ]
    }
  });
  const conversation = {
    id: 'conv-1',
    metadata: { assistantCore: { pendingActionConfirmToken: created.confirmToken } }
  };

  const calls = [];
  const fakeExecutor = {
    executeToolCall: async (invocation) => {
      calls.push(invocation.input.imagePath);
      return { status: 'completed', content: [{ type: 'text', text: `sent ${invocation.input.imagePath}` }] };
    }
  };

  const result = await resolveAssistantConfirmation({
    conversation,
    decision: 'approve',
    runStore: { get: () => null },
    pendingActionStore,
    conversationStore: null,
    executorFactory: () => fakeExecutor
  });

  assert.deepEqual(calls, ['D:\\git.png', 'D:\\github.jpg', 'D:\\postman.png'], 'all 3 sends execute');
  assert.equal(result.status, 'approved');
});

test('resolveAssistantConfirmation single (non-batch) action still executes exactly once', async () => {
  const pendingActionStore = new AssistantPendingActionStore();
  const created = pendingActionStore.create({
    conversationId: 'conv-2',
    assistantRunId: 'run-2',
    toolName: 'send_message_to_channel',
    input: { imagePath: 'D:\\only.png' },
    metadata: {}
  });
  const conversation = {
    id: 'conv-2',
    metadata: { assistantCore: { pendingActionConfirmToken: created.confirmToken } }
  };
  const calls = [];
  const fakeExecutor = {
    executeToolCall: async (invocation) => {
      calls.push(invocation.input.imagePath);
      return { status: 'completed', content: [{ type: 'text', text: 'sent' }] };
    }
  };
  const result = await resolveAssistantConfirmation({
    conversation,
    decision: 'approve',
    runStore: { get: () => null },
    pendingActionStore,
    conversationStore: null,
    executorFactory: () => fakeExecutor
  });
  assert.deepEqual(calls, ['D:\\only.png']);
  assert.equal(result.status, 'approved');
});
