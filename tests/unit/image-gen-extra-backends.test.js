import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { volcengineImagesBackend } from '../../src/image-gen/backends/volcengine-images.js';
import { wanxiangBackend } from '../../src/image-gen/backends/wanxiang.js';
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

// ── Volcengine Ark (即梦 / Seedream) ────────────────────────────────────────
test('volcengine mapParams: 16:9 → Seedream size, watermark off, negativePrompt dropped', () => {
  const entry = { nativeModel: 'doubao-seedream-3-0-t2i', apiKey: 'ark-x' };
  const { native, notes } = volcengineImagesBackend.mapParams(
    canon({ prompt: 'a city', aspectRatio: '16:9', negativePrompt: 'blur' }),
    entry
  );
  assert.equal(native.model, 'doubao-seedream-3-0-t2i');
  assert.equal(native.size, '2560x1440');
  assert.equal(native.watermark, false);
  assert.equal(native.response_format, 'url');
  assert.equal(native.sequential_image_generation, 'disabled');
  assert.ok(notes.some((n) => /negativePrompt/.test(n)));
});

test('volcengine generate: parses data[].url', async () => {
  const entry = { nativeModel: 'doubao-seedream-3-0-t2i', apiKey: 'ark-x' };
  const fetchImpl = async () => mockResponse({ json: { data: [{ url: 'https://ark/img.png' }] } });
  const out = await volcengineImagesBackend.generate({ native: { model: 'm', prompt: 'x' }, entry, fetchImpl });
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].url, 'https://ark/img.png');
  assert.equal(out.images[0].base64, undefined);
});

test('volcengine generate: 401 → AUTH', async () => {
  const entry = { nativeModel: 'm', apiKey: 'ark-x' };
  const fetchImpl = async () => mockResponse({ ok: false, status: 401, json: { error: { message: 'bad token' } } });
  await assert.rejects(
    volcengineImagesBackend.generate({ native: {}, entry, fetchImpl }),
    (err) => err.code === IMAGE_ERROR.AUTH
  );
});

// ── DashScope 通义万相 (async submit + poll) ────────────────────────────────
test('wanxiang mapParams: DashScope body shape with star size + negative_prompt', () => {
  const entry = { nativeModel: 'wan2.2-t2i-flash', apiKey: 'ds-x' };
  const { native } = wanxiangBackend.mapParams(
    canon({ prompt: 'a fox', aspectRatio: '1:1', negativePrompt: 'cartoon', n: 2 }),
    entry
  );
  assert.equal(native.model, 'wan2.2-t2i-flash');
  assert.equal(native.input.prompt, 'a fox');
  assert.equal(native.input.negative_prompt, 'cartoon');
  assert.equal(native.parameters.size, '1024*1024');
  assert.equal(native.parameters.n, 2);
  assert.equal(native.parameters.watermark, false);
});

function dashscopeFetch(pollStatuses) {
  let i = 0;
  return async (url, opts = {}) => {
    if ((opts.method || 'GET').toUpperCase() === 'POST') {
      assert.equal(opts.headers['X-DashScope-Async'], 'enable');
      return mockResponse({ json: { output: { task_id: 'task-1', task_status: 'PENDING' } } });
    }
    const status = pollStatuses[Math.min(i, pollStatuses.length - 1)];
    i += 1;
    if (status === 'SUCCEEDED') {
      return mockResponse({ json: { output: { task_status: 'SUCCEEDED', results: [{ url: 'https://oss/out.png' }] } } });
    }
    if (status === 'FAILED') {
      return mockResponse({ json: { output: { task_status: 'FAILED', message: 'content blocked' } } });
    }
    return mockResponse({ json: { output: { task_status: status } } });
  };
}

test('wanxiang generate: submits then polls RUNNING → SUCCEEDED → url', async () => {
  const entry = { nativeModel: 'wan2.2-t2i-flash', apiKey: 'ds-x' };
  const fetchImpl = dashscopeFetch(['RUNNING', 'RUNNING', 'SUCCEEDED']);
  const out = await wanxiangBackend.generate({
    native: { model: 'wan2.2-t2i-flash', input: { prompt: 'x' }, parameters: {} },
    entry, fetchImpl, pollIntervalMs: 0, maxPollAttempts: 10
  });
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].url, 'https://oss/out.png');
});

test('wanxiang generate: FAILED task → UPSTREAM error', async () => {
  const entry = { nativeModel: 'wan2.2-t2i-flash', apiKey: 'ds-x' };
  const fetchImpl = dashscopeFetch(['RUNNING', 'FAILED']);
  await assert.rejects(
    wanxiangBackend.generate({ native: { parameters: {} }, entry, fetchImpl, pollIntervalMs: 0, maxPollAttempts: 10 }),
    (err) => err.code === IMAGE_ERROR.UPSTREAM && /FAILED/.test(err.message)
  );
});

test('wanxiang generate: times out if never SUCCEEDED', async () => {
  const entry = { nativeModel: 'wan2.2-t2i-flash', apiKey: 'ds-x' };
  const fetchImpl = dashscopeFetch(['RUNNING']);
  await assert.rejects(
    wanxiangBackend.generate({ native: { parameters: {} }, entry, fetchImpl, pollIntervalMs: 0, maxPollAttempts: 3 }),
    (err) => /timed out/.test(err.message)
  );
});

test('wanxiang generate: submit 401 → AUTH (DashScope-shaped error body)', async () => {
  const entry = { nativeModel: 'wan2.2-t2i-flash', apiKey: 'ds-x' };
  const fetchImpl = async () => mockResponse({ ok: false, status: 401, json: { code: 'InvalidApiKey', message: 'bad key' } });
  await assert.rejects(
    wanxiangBackend.generate({ native: { parameters: {} }, entry, fetchImpl, pollIntervalMs: 0 }),
    (err) => err.code === IMAGE_ERROR.AUTH
  );
});
