import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import createMessagingToolHandlers from '../../src/assistant-tools/handlers/messaging.js';
import createSendMessageToChannelToolDefinition from '../../src/assistant-tools/definitions/send-message-to-channel.js';
import { AssistantRunStore } from '../../src/assistant-core/run-store.js';

// --- send_message_to_channel tool ------------------------------------------

function makeHandler({ sendImpl, conversations = {}, artifacts = {} } = {}) {
  const sent = [];
  const deliverySender = {
    async send(args) {
      sent.push(args);
      return sendImpl ? sendImpl(args) : { messageId: 'msg-1' };
    }
  };
  const conversationStore = { get: (id) => conversations[id] || null };
  const artifactServiceInstance = { getArtifact: (id) => artifacts[id] || null };
  const handlers = createMessagingToolHandlers({ deliverySender, conversationStore, artifactServiceInstance });
  return { handlers, sent };
}

const dingtalkConv = { id: 'c-ding', channel: 'dingtalk', accountId: 'default' };
const feishuConv = { id: 'c-feishu', channel: 'feishu', accountId: 'default' };

test('definition wires to handlers.sendMessageToChannel and is serialized + mutating', () => {
  const def = createSendMessageToChannelToolDefinition({ handlers: { sendMessageToChannel: 'HANDLER' } });
  assert.equal(def.name, 'send_message_to_channel');
  assert.equal(def.execute, 'HANDLER');
  assert.equal(def.parallelSafe, false);
  assert.equal(def.mutating, true);
});

test('sends an image by path to DingTalk and reports imageDelivered=true', async () => {
  const { handlers, sent } = makeHandler({ conversations: { 'c-ding': dingtalkConv } });
  const res = await handlers.sendMessageToChannel({
    input: { text: 'WeChat login page', imagePath: 'D:\\tmp\\screen.png' },
    context: { conversation: dingtalkConv }
  });
  assert.equal(res.kind, 'channel_send_result');
  assert.equal(res.delivered, true);
  assert.equal(res.imageRequested, true);
  assert.equal(res.imageDelivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].conversation.id, 'c-ding');
  assert.equal(sent[0].message.images.length, 1);
  assert.equal(sent[0].message.images[0].path, 'D:\\tmp\\screen.png');
});

test('image to a non-image channel (feishu) with text degrades to text-only; image is NOT passed', async () => {
  const { handlers, sent } = makeHandler({ conversations: { 'c-feishu': feishuConv } });
  const res = await handlers.sendMessageToChannel({
    input: { text: 'here is the page', imagePath: 'D:\\tmp\\screen.png' },
    context: { conversation: feishuConv }
  });
  assert.equal(res.delivered, true);
  assert.equal(res.imageRequested, true);
  assert.equal(res.imageSupported, false);
  assert.equal(res.imageDelivered, false);
  assert.ok(res.note && /does not support images/.test(res.note));
  assert.equal(sent[0].message.images.length, 0);
});

test('image-only to a non-image channel with no text is skipped (never sends an empty message)', async () => {
  const { handlers, sent } = makeHandler({ conversations: { 'c-feishu': feishuConv } });
  const res = await handlers.sendMessageToChannel({
    input: { imagePath: 'D:\\tmp\\screen.png' },
    context: { conversation: feishuConv }
  });
  assert.equal(res.kind, 'channel_send_skipped');
  assert.equal(res.delivered, false);
  assert.equal(sent.length, 0);
});

test('empty input is rejected', async () => {
  const { handlers } = makeHandler({ conversations: { 'c-ding': dingtalkConv } });
  const res = await handlers.sendMessageToChannel({ input: {}, context: { conversation: dingtalkConv } });
  assert.equal(res.kind, 'invalid_input');
});

test('unknown targetConversationId is rejected (never sends to an arbitrary id)', async () => {
  const { handlers, sent } = makeHandler({ conversations: { 'c-ding': dingtalkConv } });
  const res = await handlers.sendMessageToChannel({
    input: { text: 'hi', targetConversationId: 'nope' },
    context: { conversation: dingtalkConv }
  });
  assert.equal(res.kind, 'conversation_not_found');
  assert.equal(sent.length, 0);
});

test('imageArtifactId resolves the artifact and delivers on DingTalk', async () => {
  const { handlers, sent } = makeHandler({
    conversations: { 'c-ding': dingtalkConv },
    artifacts: { a1: { id: 'a1', imageUrl: 'data:image/png;base64,XXX', mediaType: 'image/png', title: 'shot', path: '' } }
  });
  const res = await handlers.sendMessageToChannel({
    input: { text: 'shot', imageArtifactId: 'a1' },
    context: { conversation: dingtalkConv }
  });
  assert.equal(res.imageDelivered, true);
  assert.equal(sent[0].message.images[0].artifactId, 'a1');
});

test('reports not-delivered when the channel has no provider (delivery-sender returns null)', async () => {
  const { handlers } = makeHandler({
    conversations: { 'c-ding': dingtalkConv },
    sendImpl: () => null
  });
  const res = await handlers.sendMessageToChannel({
    input: { text: 'hi' },
    context: { conversation: dingtalkConv }
  });
  assert.equal(res.delivered, false);
  assert.ok(res.error && /no delivery provider/.test(res.error));
});

// --- stale-run hygiene ------------------------------------------------------

test('failStaleNonTerminalRuns retires old non-terminal runs, sparing recent and terminal ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cligate-runstore-'));
  const store = new AssistantRunStore({ configDir: dir });
  const now = Date.parse('2026-05-29T12:00:00.000Z');
  const hoursAgo = (h) => new Date(now - h * 3600 * 1000).toISOString();

  store.save({ id: 'old-waiting-runtime', conversationId: 'c', status: 'waiting_runtime', createdAt: hoursAgo(48) });
  store.save({ id: 'old-queued', conversationId: 'c', status: 'queued', createdAt: hoursAgo(30) });
  store.save({ id: 'old-waiting-user', conversationId: 'c', status: 'waiting_user', createdAt: hoursAgo(72) });
  store.save({ id: 'recent-running', conversationId: 'c', status: 'running', createdAt: hoursAgo(1) });
  store.save({ id: 'old-completed', conversationId: 'c', status: 'completed', createdAt: hoursAgo(99) });

  const count = store.failStaleNonTerminalRuns({ olderThanMs: 24 * 3600 * 1000, now });

  assert.equal(count, 3);
  assert.equal(store.get('old-waiting-runtime').status, 'failed');
  assert.equal(store.get('old-queued').status, 'failed');
  assert.equal(store.get('old-waiting-user').status, 'failed');
  assert.equal(store.get('recent-running').status, 'running'); // spared: too recent
  assert.equal(store.get('old-completed').status, 'completed'); // spared: terminal
  assert.ok(store.get('old-waiting-runtime').metadata?.staleCleanup?.sweptAt);
});

test('failStaleNonTerminalRuns is idempotent (second sweep retires nothing new)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cligate-runstore-'));
  const store = new AssistantRunStore({ configDir: dir });
  const now = Date.parse('2026-05-29T12:00:00.000Z');
  store.save({ id: 'z', conversationId: 'c', status: 'waiting_runtime', createdAt: new Date(now - 48 * 3600 * 1000).toISOString() });
  assert.equal(store.failStaleNonTerminalRuns({ now }), 1);
  assert.equal(store.failStaleNonTerminalRuns({ now }), 0);
});
