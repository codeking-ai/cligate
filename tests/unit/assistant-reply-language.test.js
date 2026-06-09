import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveReplyLanguage } from '../../src/assistant-agent/react-engine.js';

// Regression for the "中英文两版" approval duplication: a single Chinese task
// ("查看文件…是什么内容") produced confirmation prompts in Chinese for the first
// command and English for every continuation command, because the assistant
// re-detected reply language from the hardcoded-English "[Assistant
// continuation — system auto-message…]" prompt of each follow-up run.
// resolveReplyLanguage must keep the language anchored to the real user turn.

test('genuine user text drives the reply language directly', () => {
  assert.equal(resolveReplyLanguage('查看文件 D:\\files\\a.pdf 是什么内容'), 'zh-CN');
  assert.equal(resolveReplyLanguage('what is in this pdf?'), 'en');
});

test('system continuation turn falls back to the latest genuine user turn (Chinese stays Chinese)', () => {
  const conversationContext = {
    recentChatTurns: [
      { role: 'user', text: '查看文件 D:\\files\\ImplementingRAGwithZilliz.pdf 是什么内容' },
      { role: 'assistant', text: '我准备执行一条系统命令，需要你确认。' },
      // The continuation auto-message is persisted as an inbound (user) turn too.
      { role: 'user', text: '[Assistant continuation — system auto-message, not from the user]\nYour previous tool call was approved.' }
    ]
  };
  const continuationText = '[Assistant continuation — system auto-message, not from the user]\nYour previous tool call `run_shell_command` was approved by the user.';

  // Before the fix this returned 'en' (English confirmation mid-Chinese-task).
  assert.equal(resolveReplyLanguage(continuationText, conversationContext), 'zh-CN');
});

test('system continuation turn respects an English conversation', () => {
  const conversationContext = {
    recentChatTurns: [
      { role: 'user', text: 'what does this pdf contain?' },
      { role: 'user', text: '[Assistant continuation — system auto-message, not from the user] ...' }
    ]
  };
  const continuationText = '[Assistant continuation — system auto-message, not from the user] ...';
  assert.equal(resolveReplyLanguage(continuationText, conversationContext), 'en');
});

test('continuation turn skips other system turns to find the real user language', () => {
  const conversationContext = {
    recentChatTurns: [
      { role: 'user', text: '帮我读取这个 PDF 的内容' },
      { role: 'user', text: '[Assistant continuation — system auto-message, not from the user] step 1' },
      { role: 'user', text: '[Assistant continuation — system auto-message, not from the user] step 2' }
    ]
  };
  assert.equal(
    resolveReplyLanguage('[Assistant continuation — system auto-message, not from the user] step 3', conversationContext),
    'zh-CN'
  );
});

test('no conversation context degrades to detecting the raw text (no crash)', () => {
  assert.equal(resolveReplyLanguage('[Assistant continuation — system auto-message, not from the user]'), 'en');
  assert.equal(resolveReplyLanguage('', null), 'en');
});
