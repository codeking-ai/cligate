import { test } from 'node:test';
import assert from 'node:assert/strict';

import { transcribeOpenAI } from '../../src/speech-to-text/providers/openai.js';
import { transcribeGemini } from '../../src/speech-to-text/providers/gemini.js';
import { TranscriptionService } from '../../src/speech-to-text/transcription-service.js';

function textResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
    async json() { return JSON.parse(body); }
  };
}

const AUDIO = Buffer.from('fake-audio-bytes');

test('transcribeOpenAI posts multipart to /audio/transcriptions with bearer auth and returns text', async () => {
  let captured = null;
  const res = await transcribeOpenAI({
    apiKey: 'sk-test',
    audio: AUDIO,
    mimeType: 'audio/webm',
    language: 'zh',
    fetchImpl: async (url, opts) => {
      captured = { url, opts };
      return textResponse('  你好世界  ');
    }
  });
  assert.equal(res.ok, true);
  assert.equal(res.text, '你好世界');
  assert.equal(res.model, 'gpt-4o-mini-transcribe');
  assert.match(captured.url, /\/audio\/transcriptions$/);
  assert.equal(captured.opts.headers.Authorization, 'Bearer sk-test');
  assert.equal(captured.opts.body.get('model'), 'gpt-4o-mini-transcribe');
  assert.equal(captured.opts.body.get('language'), 'zh');
  assert.ok(captured.opts.body.get('file'));
});

test('transcribeOpenAI falls back to the next model on 404, parses JSON body too', async () => {
  const seenModels = [];
  const res = await transcribeOpenAI({
    apiKey: 'sk-test',
    audio: AUDIO,
    fetchImpl: async (_url, opts) => {
      const model = opts.body.get('model');
      seenModels.push(model);
      if (model === 'gpt-4o-mini-transcribe') return textResponse('not found', { status: 404 });
      return textResponse('{"text":"fallback transcript"}');
    }
  });
  assert.deepEqual(seenModels, ['gpt-4o-mini-transcribe', 'whisper-1']);
  assert.equal(res.ok, true);
  assert.equal(res.text, 'fallback transcript');
  assert.equal(res.model, 'whisper-1');
});

test('transcribeOpenAI surfaces rate limiting', async () => {
  const res = await transcribeOpenAI({
    apiKey: 'sk-test',
    audio: AUDIO,
    fetchImpl: async () => textResponse('slow down', { status: 429 })
  });
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'rate_limited');
});

test('transcribeGemini sends inline base64 audio to generateContent with key in query', async () => {
  let captured = null;
  const res = await transcribeGemini({
    apiKey: 'gem-test',
    audio: AUDIO,
    mimeType: 'audio/webm',
    fetchImpl: async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body) };
      return textResponse('{"candidates":[{"content":{"parts":[{"text":"hola"}]}}]}');
    }
  });
  assert.equal(res.ok, true);
  assert.equal(res.text, 'hola');
  assert.match(captured.url, /:generateContent\?key=gem-test$/);
  assert.equal(captured.body.contents[0].parts[0].inline_data.mime_type, 'audio/webm');
  assert.equal(captured.body.contents[0].parts[0].inline_data.data, AUDIO.toString('base64'));
});

test('TranscriptionService.capabilities reports available providers', () => {
  const svc = new TranscriptionService({
    hasKeys: (types) => types.includes('openai'),
    rateLimitInfo: () => ({ allRateLimited: false, minWaitMs: 0 })
  });
  const cap = svc.capabilities();
  assert.equal(cap.available, true);
  assert.deepEqual(cap.providers, ['openai']);
  assert.equal(cap.rateLimitedMs, 0);
});

test('TranscriptionService.transcribe returns no_credential when nothing is configured', async () => {
  const svc = new TranscriptionService({ hasKeys: () => false });
  const res = await svc.transcribe({ audio: AUDIO });
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'no_credential');
});

test('TranscriptionService.transcribe uses OpenAI first', async () => {
  const svc = new TranscriptionService({
    hasKeys: () => true,
    rateLimitInfo: () => ({ allRateLimited: false, minWaitMs: 0 }),
    selectKeyImpl: (type) => ({ id: `${type}-1`, apiKey: 'k', baseUrl: '', isAvailable: true }),
    openaiImpl: async () => ({ ok: true, text: 'from openai', model: 'gpt-4o-mini-transcribe' }),
    geminiImpl: async () => ({ ok: true, text: 'from gemini', model: 'gemini-2.0-flash' })
  });
  const res = await svc.transcribe({ audio: AUDIO });
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'openai');
  assert.equal(res.text, 'from openai');
});

test('TranscriptionService.transcribe falls back to Gemini when OpenAI fails', async () => {
  const svc = new TranscriptionService({
    hasKeys: () => true,
    rateLimitInfo: () => ({ allRateLimited: false, minWaitMs: 0 }),
    selectKeyImpl: (type) => ({ id: `${type}-1`, apiKey: 'k', baseUrl: '', isAvailable: true }),
    openaiImpl: async () => ({ ok: false, kind: 'transcribe_failed', error: 'boom' }),
    geminiImpl: async () => ({ ok: true, text: 'from gemini', model: 'gemini-2.0-flash' })
  });
  const res = await svc.transcribe({ audio: AUDIO });
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'gemini');
  assert.equal(res.text, 'from gemini');
});

test('TranscriptionService.transcribe reports rate_limited when the pool is cooling down', async () => {
  const svc = new TranscriptionService({
    hasKeys: () => true,
    rateLimitInfo: () => ({ allRateLimited: true, minWaitMs: 5000 })
  });
  const res = await svc.transcribe({ audio: AUDIO });
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'rate_limited');
  assert.equal(res.retryMs, 5000);
});
