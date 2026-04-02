import test from 'node:test';
import assert from 'node:assert/strict';

import { _testExports } from '../../src/routes/messages-route.js';

const { _streamDirectWithRotation } = _testExports;

function createMockResponse() {
  return {
    headers: new Map(),
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader(name, value) {
      this.headers.set(name, value);
    },
    flushHeaders() {
      this.headersSent = true;
    },
    write() {},
    end() {
      this.writableEnded = true;
    }
  };
}

test('_streamDirectWithRotation does not commit SSE headers before upstream accepts the stream', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => new Response('rate limited', {
    status: 429,
    headers: {
      'retry-after': '1',
      'Content-Type': 'text/plain'
    }
  });

  const res = createMockResponse();

  try {
    await assert.rejects(
      () => _streamDirectWithRotation(
        res,
        {
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'hi' }]
        },
        {
          accessToken: 'token',
          accountId: 'account-id',
          email: 'user@example.com'
        },
        'claude-opus-4-6',
        Date.now(),
        null
      ),
      /RATE_LIMITED:1000:rate limited/
    );

    assert.equal(res.headersSent, false);
    assert.equal(res.headers.size, 0);
    assert.equal(res.writableEnded, false);
  } finally {
    global.fetch = originalFetch;
  }
});
