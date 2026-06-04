import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolve } from 'node:path';
import {
  hasStickyApprovalPhrase,
  parseAssistantPermissionCommand,
  getAutoApproveToolsState,
  buildAutoApproveToolsMetadata,
  parseGrantedReadRoots,
  buildGrantedReadRootsMetadata,
  getGrantedReadRoots
} from '../../src/assistant-core/auto-approve.js';
import { AgentChannelConversationStore } from '../../src/agent-channels/conversation-store.js';
import { AgentChannelDeliveryStore } from '../../src/agent-channels/delivery-store.js';
import { AgentChannelPairingStore } from '../../src/agent-channels/pairing-store.js';
import { AgentChannelRouter } from '../../src/agent-channels/router.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('hasStickyApprovalPhrase matches blanket-consent phrasing and rejects denials / single approvals', () => {
  assert.equal(hasStickyApprovalPhrase('以后所有操作都不用再问我了'), true);
  assert.equal(hasStickyApprovalPhrase('同意所有操作'), true);
  assert.equal(hasStickyApprovalPhrase('别再问我了'), true);
  assert.equal(hasStickyApprovalPhrase('from now on just do it'), true);
  // Single one-shot approvals must NOT be treated as sticky.
  assert.equal(hasStickyApprovalPhrase('同意'), false);
  assert.equal(hasStickyApprovalPhrase('确认'), false);
  assert.equal(hasStickyApprovalPhrase('继续'), false);
  // Explicit denial wins.
  assert.equal(hasStickyApprovalPhrase('我不同意所有这些'), false);
});

test('parseGrantedReadRoots extracts drive + absolute path grants from natural language', () => {
  // Drive phrasing → whole-drive read root.
  assert.deepEqual(parseGrantedReadRoots('默认可读C盘目录'), [resolve('C:\\')]);
  assert.deepEqual(parseGrantedReadRoots('以后可以读 D盘'), [resolve('D:\\')]);
  // Absolute path grant.
  assert.deepEqual(parseGrantedReadRoots('允许访问 D:\\data\\reports'), [resolve('D:\\data\\reports')]);
  // No read-intent verb → no grant (avoids over-widening on incidental paths).
  assert.deepEqual(parseGrantedReadRoots('文章内容来自 D:\\github\\proxypool-hub'), []);
  // Denial must never grant.
  assert.deepEqual(parseGrantedReadRoots('不允许读取C盘'), []);
  // Empty / irrelevant.
  assert.deepEqual(parseGrantedReadRoots('继续执行'), []);
});

test('buildGrantedReadRootsMetadata merges + dedups granted roots onto the conversation', () => {
  const conv = { metadata: { assistantCore: { grantedReadRoots: [resolve('C:\\')] } } };
  const metadata = buildGrantedReadRootsMetadata(conv, [resolve('C:\\'), resolve('D:\\data')]);
  assert.deepEqual(metadata.assistantCore.grantedReadRoots, [resolve('C:\\'), resolve('D:\\data')]);
  // Preserves other assistantCore fields and outer metadata.
  const conv2 = { metadata: { foo: 1, assistantCore: { autoApproveTools: true } } };
  const metadata2 = buildGrantedReadRootsMetadata(conv2, [resolve('E:\\x')]);
  assert.equal(metadata2.foo, 1);
  assert.equal(metadata2.assistantCore.autoApproveTools, true);
  assert.deepEqual(getGrantedReadRoots({ metadata: metadata2 }), [resolve('E:\\x')]);
});

test('parseAssistantPermissionCommand recognises /yolo and /safe', () => {
  assert.deepEqual(parseAssistantPermissionCommand('/yolo'), { command: 'yolo' });
  assert.deepEqual(parseAssistantPermissionCommand('/safe'), { command: 'safe' });
  assert.equal(parseAssistantPermissionCommand('hello'), null);
});

function buildRouter({ maybeHandleCalls, sends }) {
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-chan-yolo-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-chan-yolo-delivery-')
  });
  const pairingStore = new AgentChannelPairingStore({
    configDir: createTempDir('cligate-chan-yolo-pairing-')
  });
  const router = new AgentChannelRouter({
    conversationStore,
    deliveryStore,
    pairingStore,
    messageService: {
      runtimeSessionManager: { getSession() { return null; } },
      async routeUserMessage() { return { type: 'noop' }; },
      getRuntimeSession() { return null; },
      supervisorTaskStore: { get() { return null; }, listByConversationId() { return []; }, save(r) { return r; } },
      listPendingApprovals() { return []; },
      listPendingQuestions() { return []; }
    },
    assistantModeService: {
      async maybeHandleMessage({ text }) {
        maybeHandleCalls.push({ text: String(text || '') });
        return { type: 'assistant_response', message: 'ok' };
      }
    }
  });
  // Spy on outbound delivery regardless of the real sender wiring.
  router.deliverySender.send = async (args) => { sends.push(args); return { messageId: 'm1' }; };
  return { router, conversationStore };
}

test('channel router enables autoApproveTools on a sticky-approval phrase and still runs the message', async () => {
  const maybeHandleCalls = [];
  const sends = [];
  const { router, conversationStore } = buildRouter({ maybeHandleCalls, sends });

  await router.routeInboundMessage({
    channel: 'dingtalk',
    accountId: 'default',
    externalConversationId: 'dtalk-yolo-1',
    externalUserId: 'user-1',
    externalUserName: 'tester',
    externalMessageId: 'msg-sticky-1',
    text: '把这些图片发给我，以后所有操作都别再问我了',
    messageType: 'text'
  }, { defaultRuntimeProvider: 'codex' });

  const conversation = conversationStore.findByExternal('dingtalk', 'default', 'dtalk-yolo-1', 'user-1');
  assert.equal(getAutoApproveToolsState(conversation), true, 'sticky phrase flips the gate on');
  assert.equal(maybeHandleCalls.length, 1, 'message still reaches the supervisor');
});

test('channel router handles /yolo as a command: sets flag, acks, does NOT invoke the supervisor', async () => {
  const maybeHandleCalls = [];
  const sends = [];
  const { router, conversationStore } = buildRouter({ maybeHandleCalls, sends });

  const result = await router.routeInboundMessage({
    channel: 'dingtalk',
    accountId: 'default',
    externalConversationId: 'dtalk-yolo-2',
    externalUserId: 'user-1',
    externalMessageId: 'msg-yolo-cmd',
    text: '/yolo',
    messageType: 'text'
  }, { defaultRuntimeProvider: 'codex' });

  const conversation = conversationStore.findByExternal('dingtalk', 'default', 'dtalk-yolo-2', 'user-1');
  assert.equal(getAutoApproveToolsState(conversation), true);
  assert.equal(maybeHandleCalls.length, 0, '/yolo is a command, not a task for the supervisor');
  assert.equal(sends.length, 1, 'an acknowledgement is delivered');
  assert.match(String(sends[0]?.message?.text || ''), /自动同意/);
  assert.equal(result?.enabled, true);
});

test('channel router /safe turns auto-approve back off', async () => {
  const maybeHandleCalls = [];
  const sends = [];
  const { router, conversationStore } = buildRouter({ maybeHandleCalls, sends });

  // Pre-enable via a conversation patch using the shared metadata builder.
  const created = conversationStore.findOrCreateByExternal({
    channel: 'dingtalk',
    accountId: 'default',
    externalConversationId: 'dtalk-yolo-3',
    externalUserId: 'user-1',
    title: 'tester / dingtalk'
  });
  conversationStore.patch(created.id, {
    metadata: buildAutoApproveToolsMetadata(created, true, { now: '2026-06-03T00:00:00.000Z' })
  });

  await router.routeInboundMessage({
    channel: 'dingtalk',
    accountId: 'default',
    externalConversationId: 'dtalk-yolo-3',
    externalUserId: 'user-1',
    externalMessageId: 'msg-safe-cmd',
    text: '/safe',
    messageType: 'text'
  }, { defaultRuntimeProvider: 'codex' });

  const conversation = conversationStore.findByExternal('dingtalk', 'default', 'dtalk-yolo-3', 'user-1');
  assert.equal(getAutoApproveToolsState(conversation), false);
  assert.equal(maybeHandleCalls.length, 0);
});
