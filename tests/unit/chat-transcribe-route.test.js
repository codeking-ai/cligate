import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { handleTranscribe, handleTranscribeCapabilities } from '../../src/routes/chat-transcribe-route.js';
import { transcriptionService } from '../../src/speech-to-text/index.js';

async function withServer(run) {
  const app = express();
  // No body parser — matches server.js placing these before express.json().
  app.post('/api/chat/transcribe', handleTranscribe);
  app.get('/api/chat/transcribe/capabilities', handleTranscribeCapabilities);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    server.close();
  }
}

function stub(method, impl) {
  const original = transcriptionService[method];
  transcriptionService[method] = impl;
  return () => { transcriptionService[method] = original; };
}

test('GET capabilities returns the service capability snapshot', async () => {
  const restore = stub('capabilities', () => ({ available: true, providers: ['openai'], rateLimitedMs: 0 }));
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/chat/transcribe/capabilities`);
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.equal(json.success, true);
      assert.equal(json.server.available, true);
      assert.deepEqual(json.server.providers, ['openai']);
    });
  } finally {
    restore();
  }
});

test('POST transcribe returns text on success', async () => {
  let received = null;
  const restore = stub('transcribe', async ({ audio, mimeType, language }) => {
    received = { size: audio.length, mimeType, language };
    return { ok: true, text: '你好', provider: 'openai', model: 'gpt-4o-mini-transcribe' };
  });
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/chat/transcribe?lang=zh`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/webm' },
        body: Buffer.from('fake-audio')
      });
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.equal(json.success, true);
      assert.equal(json.text, '你好');
      assert.equal(json.provider, 'openai');
      assert.equal(received.mimeType, 'audio/webm');
      assert.equal(received.language, 'zh');
      assert.ok(received.size > 0);
    });
  } finally {
    restore();
  }
});

test('POST transcribe maps no_credential→503 and rate_limited→429 (so the client falls back)', async () => {
  let restore = stub('transcribe', async () => ({ ok: false, kind: 'no_credential', error: 'no key' }));
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/chat/transcribe`, {
        method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.from('x')
      });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).kind, 'no_credential');
    });
  } finally { restore(); }

  restore = stub('transcribe', async () => ({ ok: false, kind: 'rate_limited', error: 'slow down', retryMs: 5000 }));
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/chat/transcribe`, {
        method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.from('x')
      });
      const json = await res.json();
      assert.equal(res.status, 429);
      assert.equal(json.kind, 'rate_limited');
      assert.equal(json.retryMs, 5000);
    });
  } finally { restore(); }
});

test('POST transcribe rejects unsupported audio types and empty bodies', async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/api/chat/transcribe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: Buffer.from('x')
    });
    assert.equal(bad.status, 415);

    const empty = await fetch(`${base}/api/chat/transcribe`, {
      method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.alloc(0)
    });
    assert.equal(empty.status, 400);
  });
});
