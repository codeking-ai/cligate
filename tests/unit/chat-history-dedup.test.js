import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatPageModule } from '../../public/js/modules/chat-page.js';

// Regression for chat-history "duplicate display": /api/agent-channels/conversations
// returns chat-ui (the local Web chats), internal *-scope conversations, AND the
// remote channels the user already opened as local shadow sessions. unifiedChatHistory
// listed all of them next to the local cards, flooding the drawer with redundant
// "Chat UI / chat_xxx" cards and double telegram/scheduled entries.
function createHarness(overrides = {}) {
  globalThis.localStorage = {
    getItem() { return null; },
    setItem() {},
    removeItem() {}
  };
  return {
    ...createChatPageModule(),
    lang: 'en',
    chatHistoryChannelFilter: 'all',
    chatSessions: [],
    channelConversations: [],
    t(key) { return key; },
    ...overrides
  };
}

test('unifiedChatHistory drops chat-ui/web and *-scope remote cards but keeps real external channels', () => {
  const app = createHarness({
    chatSessions: [
      { id: 'chat_hi_1', mode: 'assistant', title: 'hi', messages: [{ role: 'user', content: 'hi' }], updatedAt: '2026-06-09T12:30:00.000Z' }
    ],
    channelConversations: [
      // chat-ui echo of a local web chat → must be hidden
      { id: 'conv-chatui-1', channel: 'chat-ui', title: 'Chat UI / chat_hi_1', updatedAt: '2026-06-09T12:30:00.000Z' },
      // internal scheduled scope → must be hidden
      { id: 'conv-sched-1', channel: 'scheduled-task-scope', title: '[scheduled] 提醒适当休息', updatedAt: '2026-06-09T11:00:00.000Z' },
      // real external channels → must remain
      { id: 'conv-feishu-1', channel: 'feishu', title: 'Feishu thread', updatedAt: '2026-06-09T10:00:00.000Z' },
      { id: 'conv-dingtalk-1', channel: 'dingtalk', title: 'DingTalk thread', updatedAt: '2026-06-09T09:00:00.000Z' }
    ]
  });

  const cards = app.unifiedChatHistory();
  const channels = cards.map((c) => c.channel);

  assert.equal(cards.filter((c) => c.channel === 'chat-ui').length, 0);
  assert.equal(cards.filter((c) => c.channel === 'scheduled-task-scope').length, 0);
  assert.ok(channels.includes('feishu'));
  assert.ok(channels.includes('dingtalk'));
  // The single local web chat stays.
  assert.equal(cards.filter((c) => c.type === 'local').length, 1);
});

test('unifiedChatHistory dedupes a remote channel already opened as a local shadow session', () => {
  const convId = 'cf72b119-2ab6-4ca5-933c-3846214c9b33';
  const app = createHarness({
    chatSessions: [
      { id: 'chat_remote_' + convId, mode: 'agent-runtime', originConversationId: convId, title: 'Steven YiYao / telegram', messages: [], updatedAt: '2026-06-09T12:00:00.000Z' }
    ],
    channelConversations: [
      { id: convId, conversationId: convId, channel: 'telegram', title: 'Steven YiYao / telegram', updatedAt: '2026-06-09T12:00:00.000Z' }
    ]
  });

  const cards = app.unifiedChatHistory();
  // Only the local shadow card — the remote telegram duplicate is suppressed.
  assert.equal(cards.length, 1);
  assert.equal(cards[0].type, 'local');
});

test('unifiedChatHistory keeps genuinely distinct local conversations that share a title', () => {
  // hi×3 / PDF×3 are SEPARATE conversations (different ids/content) — they must
  // NOT be merged, only the false remote duplicates are removed.
  const app = createHarness({
    chatSessions: [
      { id: 'chat_a', mode: 'assistant', title: 'hi', messages: [{ role: 'user', content: 'hi' }], updatedAt: '2026-06-09T12:30:00.000Z' },
      { id: 'chat_b', mode: 'assistant', title: 'hi', messages: [{ role: 'user', content: 'hi' }], updatedAt: '2026-06-09T12:10:00.000Z' },
      { id: 'chat_c', mode: 'assistant', title: 'hi', messages: [{ role: 'user', content: 'hi' }], updatedAt: '2026-06-09T05:37:00.000Z' }
    ],
    channelConversations: []
  });

  const cards = app.unifiedChatHistory();
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map((c) => c.raw.id).sort(), ['chat_a', 'chat_b', 'chat_c']);
});

test('isHiddenHistoryChannel only hides local/internal channels', () => {
  const app = createHarness();
  assert.equal(app.isHiddenHistoryChannel('chat-ui'), true);
  assert.equal(app.isHiddenHistoryChannel('web'), true);
  assert.equal(app.isHiddenHistoryChannel('scheduled-task-scope'), true);
  assert.equal(app.isHiddenHistoryChannel('some-other-scope'), true);
  assert.equal(app.isHiddenHistoryChannel('telegram'), false);
  assert.equal(app.isHiddenHistoryChannel('feishu'), false);
  assert.equal(app.isHiddenHistoryChannel('dingtalk'), false);
  assert.equal(app.isHiddenHistoryChannel(''), false);
});
