import test from 'node:test';
import assert from 'node:assert/strict';

import {
  transcribeViaServer,
  probeServerCapability,
  transcribeAudio
} from '../../public/js/modules/speech-to-text.js';

const fakeBlob = { type: 'audio/webm', size: 10 };

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return body; } };
}

test('transcribeViaServer returns text and backend on success', async () => {
  let captured = null;
  const res = await transcribeViaServer(fakeBlob, {
    lang: 'zh',
    fetchImpl: async (url, opts) => {
      captured = { url, opts };
      return jsonResponse({ success: true, text: '你好', provider: 'openai' });
    }
  });
  assert.equal(res.text, '你好');
  assert.equal(res.backend, 'server:openai');
  assert.match(captured.url, /\/api\/chat\/transcribe\?lang=zh$/);
  assert.equal(captured.opts.headers['Content-Type'], 'audio/webm');
});

test('transcribeViaServer throws with kind on 503 so caller can fall back', async () => {
  await assert.rejects(
    () => transcribeViaServer(fakeBlob, {
      fetchImpl: async () => jsonResponse({ success: false, kind: 'no_credential', error: 'no key' }, { ok: false, status: 503 })
    }),
    (err) => { assert.equal(err.kind, 'no_credential'); assert.equal(err.status, 503); return true; }
  );
});

test('probeServerCapability returns the server snapshot and never throws', async () => {
  const cap = await probeServerCapability({
    fetchImpl: async () => jsonResponse({ success: true, server: { available: true, providers: ['gemini'] } })
  });
  assert.equal(cap.available, true);
  assert.deepEqual(cap.providers, ['gemini']);

  const downed = await probeServerCapability({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(downed.available, false);
});

test('transcribeAudio prefers the server when available', async () => {
  let usedWhisper = false;
  const res = await transcribeAudio(fakeBlob, {
    serverAvailable: true,
    serverImpl: async () => ({ text: 'from server', backend: 'server:openai' }),
    whisperImpl: async () => { usedWhisper = true; return { text: 'from whisper', backend: 'whisper' }; }
  });
  assert.equal(res.text, 'from server');
  assert.equal(usedWhisper, false);
});

test('transcribeAudio falls back to Whisper when the server fails', async () => {
  const res = await transcribeAudio(fakeBlob, {
    serverAvailable: true,
    serverImpl: async () => { const e = new Error('no key'); e.kind = 'no_credential'; throw e; },
    whisperImpl: async () => ({ text: 'from whisper', backend: 'whisper' })
  });
  assert.equal(res.text, 'from whisper');
  assert.equal(res.backend, 'whisper');
});

test('transcribeAudio goes straight to Whisper when the server is unavailable', async () => {
  let serverCalled = false;
  const res = await transcribeAudio(fakeBlob, {
    serverAvailable: false,
    serverImpl: async () => { serverCalled = true; return { text: 'x' }; },
    whisperImpl: async () => ({ text: 'local', backend: 'whisper' })
  });
  assert.equal(serverCalled, false);
  assert.equal(res.text, 'local');
});

test('transcribeAudio probes capability when availability is unknown', async () => {
  let probed = false;
  const res = await transcribeAudio(fakeBlob, {
    serverAvailable: null,
    probeImpl: async () => { probed = true; return { available: false }; },
    serverImpl: async () => ({ text: 'server' }),
    whisperImpl: async () => ({ text: 'local', backend: 'whisper' })
  });
  assert.equal(probed, true);
  assert.equal(res.text, 'local');
});
