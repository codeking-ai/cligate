import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import createMessagingToolHandlers from '../../src/assistant-tools/handlers/messaging.js';
import createSendMessageToChannelToolDefinition from '../../src/assistant-tools/definitions/send-message-to-channel.js';
import { AssistantRunStore } from '../../src/assistant-core/run-store.js';
import { buildActiveAssistantRunsSummary } from '../../src/assistant-core/observation-service.js';
import { ASSISTANT_RUN_STATUS } from '../../src/assistant-core/models.js';
import AssistantReactEngine from '../../src/assistant-agent/react-engine.js';

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
const telegramConv = { id: 'c-tg', channel: 'telegram', accountId: 'default' };
// A channel with no image-capable provider — exercises the degrade/skip path.
const noImageConv = { id: 'c-noimg', channel: 'webchat', accountId: 'default' };

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

test('sends an image by path to Feishu and reports imageDelivered=true', async () => {
  const { handlers, sent } = makeHandler({ conversations: { 'c-feishu': feishuConv } });
  const res = await handlers.sendMessageToChannel({
    input: { text: 'here is the page', imagePath: 'D:\\tmp\\screen.png' },
    context: { conversation: feishuConv }
  });
  assert.equal(res.kind, 'channel_send_result');
  assert.equal(res.delivered, true);
  assert.equal(res.imageRequested, true);
  assert.equal(res.imageSupported, true);
  assert.equal(res.imageDelivered, true);
  assert.equal(sent[0].message.images.length, 1);
  assert.equal(sent[0].message.images[0].path, 'D:\\tmp\\screen.png');
});

test('sends an image-only message to Telegram and reports imageDelivered=true', async () => {
  const { handlers, sent } = makeHandler({ conversations: { 'c-tg': telegramConv } });
  const res = await handlers.sendMessageToChannel({
    input: { imagePath: 'D:\\tmp\\screen.png' },
    context: { conversation: telegramConv }
  });
  assert.equal(res.delivered, true);
  assert.equal(res.imageRequested, true);
  assert.equal(res.imageSupported, true);
  assert.equal(res.imageDelivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.images.length, 1);
});

test('image to a channel without image support, with text, degrades to text-only; image is NOT passed', async () => {
  const { handlers, sent } = makeHandler({ conversations: { 'c-noimg': noImageConv } });
  const res = await handlers.sendMessageToChannel({
    input: { text: 'here is the page', imagePath: 'D:\\tmp\\screen.png' },
    context: { conversation: noImageConv }
  });
  assert.equal(res.delivered, true);
  assert.equal(res.imageRequested, true);
  assert.equal(res.imageSupported, false);
  assert.equal(res.imageDelivered, false);
  assert.ok(res.note && /does not support images/.test(res.note));
  assert.equal(sent[0].message.images.length, 0);
});

test('image-only to a channel without image support and no text is skipped (never sends an empty message)', async () => {
  const { handlers, sent } = makeHandler({ conversations: { 'c-noimg': noImageConv } });
  const res = await handlers.sendMessageToChannel({
    input: { imagePath: 'D:\\tmp\\screen.png' },
    context: { conversation: noImageConv }
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

// --- screenshot path recovery ----------------------------------------------
// The supervisor sometimes passes a fabricated/approximate screenshot path
// (wrong dir and/or filename) instead of the exact path desktop_capture_window
// returned — so send_message_to_channel recovers from the canonical desktop
// screenshots dir (DESKTOP_CONTROL_DIR/screenshots).

function withDesktopControlDir(base, fn) {
  const prev = process.env.DESKTOP_CONTROL_DIR;
  process.env.DESKTOP_CONTROL_DIR = base;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.DESKTOP_CONTROL_DIR;
      else process.env.DESKTOP_CONTROL_DIR = prev;
    });
}

test('screenshot send recovers from a fabricated path by sending the latest screenshot', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cligate-desktop-ctl-'));
  const shotsDir = join(base, 'screenshots');
  mkdirSync(shotsDir, { recursive: true });
  const older = join(shotsDir, 'screen-region-20260601-174133-134811.png');
  const newest = join(shotsDir, 'screen-region-20260601-174743-628786.png');
  writeFileSync(older, 'older');
  writeFileSync(newest, 'newest');
  // Force a strictly-later mtime on the newest so selection is deterministic.
  utimesSync(older, new Date('2026-06-01T17:41:33Z'), new Date('2026-06-01T17:41:33Z'));
  utimesSync(newest, new Date('2026-06-01T17:47:43Z'), new Date('2026-06-01T17:47:43Z'));

  await withDesktopControlDir(base, async () => {
    const { handlers, sent } = makeHandler({ conversations: { 'c-ding': dingtalkConv } });
    const res = await handlers.sendMessageToChannel({
      // Exactly the fabricated path from the incident: wrong base + capture_* name.
      input: { text: '截图', imagePath: 'D:\\.tmp\\desktop-control-agent\\screenshots\\capture_20260601_174742_389.png' },
      context: { conversation: dingtalkConv }
    });
    assert.equal(res.delivered, true);
    assert.equal(res.imageDelivered, true);
    assert.ok(res.note && /Sent the current screenshot/.test(res.note));
    assert.ok(/imageArtifactId/.test(res.note));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.images[0].path, newest);
  });
});

test('screenshot send prefers an exact basename match over the newest file', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cligate-desktop-ctl-'));
  const shotsDir = join(base, 'screenshots');
  mkdirSync(shotsDir, { recursive: true });
  const wanted = join(shotsDir, 'screen-region-20260601-174133-134811.png');
  const newer = join(shotsDir, 'screen-region-20260601-180000-000000.png');
  writeFileSync(wanted, 'wanted');
  writeFileSync(newer, 'newer');
  utimesSync(wanted, new Date('2026-06-01T17:41:33Z'), new Date('2026-06-01T17:41:33Z'));
  utimesSync(newer, new Date('2026-06-01T18:00:00Z'), new Date('2026-06-01T18:00:00Z'));

  await withDesktopControlDir(base, async () => {
    const { handlers, sent } = makeHandler({ conversations: { 'c-ding': dingtalkConv } });
    const res = await handlers.sendMessageToChannel({
      // Right filename, wrong directory — basename match should win over newest.
      input: { imagePath: 'D:\\wrong\\dir\\screen-region-20260601-174133-134811.png' },
      context: { conversation: dingtalkConv }
    });
    assert.equal(res.imageDelivered, true);
    assert.equal(sent[0].message.images[0].path, wanted);
  });
});

test('a missing NON-screenshot image path is left untouched (no latest-screenshot hijack)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cligate-desktop-ctl-'));
  const shotsDir = join(base, 'screenshots');
  mkdirSync(shotsDir, { recursive: true });
  writeFileSync(join(shotsDir, 'screen-region-20260601-174743-628786.png'), 'shot');

  await withDesktopControlDir(base, async () => {
    const { handlers, sent } = makeHandler({ conversations: { 'c-ding': dingtalkConv } });
    const res = await handlers.sendMessageToChannel({
      input: { imagePath: 'D:\\Downloads\\report-cover.png' },
      context: { conversation: dingtalkConv }
    });
    assert.ok(!res.note || !/recovered/.test(res.note));
    assert.equal(sent[0].message.images[0].path, 'D:\\Downloads\\report-cover.png');
  });
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

// --- self-listing fix (the 2026-06-02 self-cancel root cause) --------------

const noEvents = { list: () => [] };

test('buildActiveAssistantRunsSummary excludes the current run (no self-listing)', () => {
  // The supervisor's own run is still queued/running while it reasons. Listing
  // it back to the LLM is what made it cancel itself.
  const runs = [
    { id: 'run-self', status: ASSISTANT_RUN_STATUS.QUEUED },
    { id: 'run-other', status: ASSISTANT_RUN_STATUS.RUNNING }
  ];
  const summary = buildActiveAssistantRunsSummary(runs, noEvents, 5, undefined, { excludeRunId: 'run-self' });
  assert.deepEqual(summary.map((entry) => entry.id), ['run-other']);
});

test('buildActiveAssistantRunsSummary lists all active runs when no excludeRunId is given', () => {
  const runs = [
    { id: 'run-a', status: ASSISTANT_RUN_STATUS.QUEUED },
    { id: 'run-b', status: ASSISTANT_RUN_STATUS.RUNNING }
  ];
  const summary = buildActiveAssistantRunsSummary(runs, noEvents, 5);
  assert.deepEqual(summary.map((entry) => entry.id).sort(), ['run-a', 'run-b']);
});

// --- ReAct loop cancellation enforcement + terminal consistency ------------

test('react loop halts before any LLM turn when the run is already cancelled, and finalizes as cancelled', async () => {
  const emptyCwd = mkdtempSync(join(tmpdir(), 'cligate-react-cwd-'));
  let completeCalls = 0;
  const engine = new AssistantReactEngine({
    llmClient: { complete: async () => { completeCalls += 1; return { text: '', toolCalls: [], source: {} }; } },
    toolRegistry: { list: () => [] },
    toolExecutor: { executeToolCall: async () => ({ status: 'completed', content: [], structured: null, metadata: {} }) },
    runEventStore: null,
    runStore: { get: (id) => (id === 'run-cancel-loop' ? { id, status: ASSISTANT_RUN_STATUS.CANCELLED } : null) }
  });

  const executed = await engine.run({
    run: { id: 'run-cancel-loop', status: ASSISTANT_RUN_STATUS.QUEUED, metadata: {} },
    conversation: { id: 'c-cancel' },
    text: 'open chrome and log in',
    cwd: emptyCwd
  });

  // The loop must not spend an LLM turn or any tool call once cancelled, and the
  // run must finalize as CANCELLED — not be overwritten with "completed".
  assert.equal(completeCalls, 0, 'LLM must not be called once the run is cancelled');
  assert.equal(executed.run.status, ASSISTANT_RUN_STATUS.CANCELLED);
});

test('isRunCancelled is fail-open: a throwing store read reports not-cancelled', () => {
  const engine = new AssistantReactEngine({
    llmClient: {},
    toolRegistry: { list: () => [] },
    toolExecutor: {},
    runStore: { get: () => { throw new Error('store boom'); } }
  });
  assert.equal(engine.isRunCancelled('whatever'), false);
});
