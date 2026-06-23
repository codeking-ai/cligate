import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { openAiImagesBackend } from '../../src/image-gen/backends/openai-images.js';
import { IMAGE_ERROR } from '../../src/image-gen/backend.js';
import { normalizeCanonicalInput } from '../../src/image-gen/canonical.js';

function canon(input) {
  return normalizeCanonicalInput(input).canonical;
}

function mockResponse({ ok = true, status = 200, json = {}, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    json: async () => json,
    text: async () => (typeof json === 'string' ? json : JSON.stringify(json))
  };
}

test('mapParams: gpt-image-1 maps landscape size + quality, drops negativePrompt with a note', () => {
  const entry = { nativeModel: 'gpt-image-1', apiKey: 'sk-x' };
  const { native, notes } = openAiImagesBackend.mapParams(
    canon({ prompt: 'a fox', aspectRatio: '16:9', quality: 'high', negativePrompt: 'blurry' }),
    entry
  );
  assert.equal(native.model, 'gpt-image-1');
  assert.equal(native.size, '1536x1024');
  assert.equal(native.quality, 'high');
  assert.equal(native.response_format, undefined, 'gpt-image-1 must NOT send response_format');
  assert.ok(notes.some((n) => /negativePrompt/.test(n)));
});

test('mapParams: dall-e-3 clamps n to 1, maps hd quality + 1792 landscape + response_format', () => {
  const entry = { nativeModel: 'dall-e-3', apiKey: 'sk-x' };
  const { native, notes } = openAiImagesBackend.mapParams(
    canon({ prompt: 'a fox', aspectRatio: '16:9', quality: 'high', n: 4 }),
    entry
  );
  assert.equal(native.n, 1);
  assert.equal(native.size, '1792x1024');
  assert.equal(native.quality, 'hd');
  assert.equal(native.response_format, 'b64_json');
  assert.ok(notes.some((n) => /at most 1/.test(n)));
});

test('mapParams: entry defaultParams and providerParams override mapped natives', () => {
  const entry = { nativeModel: 'gpt-image-1', apiKey: 'sk-x', defaultParams: { background: 'transparent' } };
  const { native } = openAiImagesBackend.mapParams(
    canon({ prompt: 'logo', providerParams: { size: '1024x1024' } }),
    entry
  );
  assert.equal(native.background, 'transparent');
  assert.equal(native.size, '1024x1024');
});

test('generate: parses b64_json into image bytes', async () => {
  const entry = { nativeModel: 'gpt-image-1', apiKey: 'sk-x' };
  const fetchImpl = async () => mockResponse({ json: { data: [{ b64_json: 'aGVsbG8=' }] } });
  const out = await openAiImagesBackend.generate({ native: { model: 'gpt-image-1', prompt: 'x' }, entry, fetchImpl });
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].base64, 'aGVsbG8=');
  assert.equal(out.images[0].mediaType, 'image/png');
});

test('generate: maps 429 to RATE_LIMITED with retryAfterMs from header', async () => {
  const entry = { nativeModel: 'gpt-image-1', apiKey: 'sk-x' };
  const fetchImpl = async () => mockResponse({ ok: false, status: 429, headers: { 'retry-after': '12' }, json: { error: { message: 'slow down' } } });
  await assert.rejects(
    openAiImagesBackend.generate({ native: {}, entry, fetchImpl }),
    (err) => {
      assert.equal(err.code, IMAGE_ERROR.RATE_LIMITED);
      assert.equal(err.retryAfterMs, 12000);
      return true;
    }
  );
});

test('generate: maps 401 to AUTH_EXPIRED', async () => {
  const entry = { nativeModel: 'gpt-image-1', apiKey: 'sk-x' };
  const fetchImpl = async () => mockResponse({ ok: false, status: 401, json: { error: { message: 'bad key' } } });
  await assert.rejects(
    openAiImagesBackend.generate({ native: {}, entry, fetchImpl }),
    (err) => err.code === IMAGE_ERROR.AUTH
  );
});

test('generate: missing apiKey throws AUTH before any fetch', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return mockResponse(); };
  await assert.rejects(
    openAiImagesBackend.generate({ native: {}, entry: {}, fetchImpl }),
    (err) => err.code === IMAGE_ERROR.AUTH
  );
  assert.equal(called, false);
});
