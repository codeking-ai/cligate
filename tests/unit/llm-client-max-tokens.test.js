import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMaxTokensForModel } from '../../src/assistant-agent/llm-client.js';

test('resolveMaxTokensForModel returns the per-model published cap', () => {
  // These values shadow openclaw-config's MODEL_METADATA. If they drift apart,
  // update MAX_TOKENS_BY_MODEL in llm-client.js — long tool_use args (write_file
  // with large script bodies) need the full cap, not the 1200-token default
  // that used to ship and silently truncated everything.
  assert.equal(resolveMaxTokensForModel('claude-opus-4-7'), 32768);
  assert.equal(resolveMaxTokensForModel('claude-sonnet-4-6'), 16384);
  assert.equal(resolveMaxTokensForModel('claude-haiku-4-5'), 8192);
  assert.equal(resolveMaxTokensForModel('gpt-5.4'), 16384);
  assert.equal(resolveMaxTokensForModel('gpt-5.3-codex'), 32768);
});

test('resolveMaxTokensForModel falls back to a safe default for unknown models', () => {
  const unknown = resolveMaxTokensForModel('made-up-model-x');
  assert.ok(unknown >= 4096 && unknown <= 65536);
});

test('resolveMaxTokensForModel honours the caller override before the per-model table', () => {
  const value = resolveMaxTokensForModel('gpt-5.4', { override: 12000 });
  assert.equal(value, 12000);
});

test('resolveMaxTokensForModel honours CLIGATE_ASSISTANT_MAX_TOKENS env when no override is supplied', () => {
  const previous = process.env.CLIGATE_ASSISTANT_MAX_TOKENS;
  process.env.CLIGATE_ASSISTANT_MAX_TOKENS = '20000';
  try {
    assert.equal(resolveMaxTokensForModel('gpt-5.4'), 20000);
    assert.equal(resolveMaxTokensForModel('gpt-5.4', { override: 25000 }), 25000);
  } finally {
    if (previous === undefined) delete process.env.CLIGATE_ASSISTANT_MAX_TOKENS;
    else process.env.CLIGATE_ASSISTANT_MAX_TOKENS = previous;
  }
});

test('resolveMaxTokensForModel clamps absurdly small caller values up to the floor', () => {
  // The old default of 1200 must never come back even if a caller asks for it
  // explicitly: anything below the floor gets bumped up to 4096 so tool_use
  // arguments stay intact.
  assert.equal(resolveMaxTokensForModel('gpt-5.4', { override: 1200 }), 4096);
  assert.equal(resolveMaxTokensForModel('gpt-5.4', { override: 100 }), 4096);
});

test('resolveMaxTokensForModel clamps unreasonably large values down to the ceiling', () => {
  assert.equal(resolveMaxTokensForModel('gpt-5.4', { override: 999_999 }), 65536);
});
