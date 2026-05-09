import './test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

const baseUrl = process.env.ROUTING_TEST_BASE_URL || 'http://localhost:8081';

// Tests expect the proxy server to already be running.
// Set ROUTING_TEST_BASE_URL to override the default.
const shouldSkip = process.env.ENABLE_LIVE_SERVER_TESTS !== 'true';

async function postJson(path, body) {
  const url = new URL(path, baseUrl);
  const payload = JSON.stringify(body);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = null;
  }
  return { status: response.status, json, text };
}

async function getJson(path) {
  const url = new URL(path, baseUrl);
  const response = await fetch(url);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = null;
  }
  return { status: response.status, json, text };
}

test('routes claude-haiku-4 to kilo without auth', { skip: shouldSkip }, async () => {
  const payload = {
    model: 'claude-haiku-4',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'ping' }],
    stream: false
  };

  const { status, json, text } = await postJson('/v1/messages', payload);
  assert.equal(status, 200, `Expected 200, got ${status}: ${text}`);
  assert.equal(json?.type, 'message');
  assert.equal(json?.model, 'claude-haiku-4');
  assert.ok(Array.isArray(json?.content));
});

test('switches haiku kilo model via settings endpoint', { skip: shouldSkip }, async () => {
  const setRes = await postJson('/settings/haiku-model', { haikuKiloModel: 'minimax-2.5' });
  assert.equal(setRes.status, 200);
  assert.equal(setRes.json?.haikuKiloModel, 'minimax-2.5');

  const getRes = await getJson('/settings/haiku-model');
  assert.equal(getRes.status, 200);
  assert.equal(getRes.json?.haikuKiloModel, 'minimax-2.5');
});

function startLogListener() {
  const url = new URL('/api/logs/stream?history=false', baseUrl);
  const req = http.get(url);
  const logs = [];

  req.on('response', (res) => {
    res.setEncoding('utf8');
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk;
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        if (!part.startsWith('data:')) continue;
        const data = part.slice(5).trim();
        if (!data) continue;
        try {
          logs.push(JSON.parse(data));
        } catch (_) {
          // ignore
        }
      }
    });
  });

  return { req, logs };
}

test('logs show kilo and codex routing', { skip: shouldSkip }, async () => {
  const listener = startLogListener();

  const haikuPayload = {
    model: 'claude-haiku-4',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'ping' }],
    stream: false
  };
  await postJson('/v1/messages', haikuPayload);

  const opusPayload = {
    model: 'claude-opus-4-5',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'ping' }],
    stream: false
  };
  await postJson('/v1/messages', opusPayload);

  await new Promise((resolve) => setTimeout(resolve, 500));
  listener.req.destroy();

  const messages = listener.logs
    .map((entry) => entry?.message)
    .filter(Boolean);

  assert.ok(
    messages.some((msg) => msg.includes('model=moonshotai/kimi-k2.5:free') || msg.includes('model=minimax/minimax-m2.5:free')),
    `Expected kilo model log, got: ${messages.join(' | ')}`
  );

  assert.ok(
    messages.some((msg) => msg.includes('model=gpt-5.3-codex')),
    `Expected codex model log, got: ${messages.join(' | ')}`
  );
});
