import test from 'node:test';
import assert from 'node:assert/strict';

import { sendClaudeStream, _testExports } from '../../src/claude-api.js';

test('buildClaudeNetworkError includes processed and original fetch cause details', () => {
  const cause = new Error('connect ETIMEDOUT api.anthropic.com');
  cause.code = 'ETIMEDOUT';
  const error = new TypeError('fetch failed', { cause });

  const wrapped = _testExports.buildClaudeNetworkError('stream', error);
  assert.match(wrapped.message, /CLAUDE_NETWORK_ERROR: stream failed:/);
  assert.match(wrapped.message, /fetch failed/);
  assert.match(wrapped.message, /connect ETIMEDOUT api\.anthropic\.com/);
  assert.match(wrapped.message, /code=ETIMEDOUT/);
});

test('sendClaudeStream surfaces wrapped network errors with original cause details', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    const cause = new Error('socket hang up');
    cause.code = 'ECONNRESET';
    throw new TypeError('fetch failed', { cause });
  };

  try {
    await assert.rejects(
      () => sendClaudeStream({
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'hi' }]
      }, 'token'),
      /CLAUDE_NETWORK_ERROR: stream failed: fetch failed \| connect|CLAUDE_NETWORK_ERROR: stream failed: fetch failed \| socket hang up \| code=ECONNRESET/
    );
  } finally {
    global.fetch = originalFetch;
  }
});
