import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import TelegramChannelProvider from '../../src/agent-channels/providers/telegram-provider.js';

function createFetchStub(handler) {
  return async (url, options = {}) => {
    const response = await handler(String(url), options);
    const headers = response.headers || {};
    return {
      ok: response.ok !== false,
      status: response.status || (response.ok === false ? 500 : 200),
      headers: {
        get(key) {
          return headers[String(key || '').toLowerCase()] ?? null;
        }
      },
      async json() {
        return response.json ?? {};
      },
      async arrayBuffer() {
        return response.arrayBuffer ?? new ArrayBuffer(0);
      }
    };
  };
}

function bodyToString(body) {
  if (Buffer.isBuffer(body)) return body.toString('latin1');
  return String(body || '');
}

function makeProvider(handler) {
  const calls = [];
  const provider = new TelegramChannelProvider({
    fetchImpl: createFetchStub(async (url, options) => {
      calls.push({ url, options });
      return handler(url, options);
    })
  });
  provider.settings = { botToken: 'tok-1', mode: 'polling' };
  provider.logger = { warn() {} };
  return { provider, calls };
}

test('Telegram text-only delivery still uses sendMessage JSON and never uploads a photo', async () => {
  const { provider, calls } = makeProvider(async () => ({ json: { ok: true, result: { message_id: 11 } } }));

  const result = await provider.sendMessage({
    conversation: { externalConversationId: 'chat-1' },
    text: 'hello world'
  });

  assert.equal(result.messageId, '11');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/sendMessage$/);
  assert.match(String(calls[0].options.headers['Content-Type']), /application\/json/);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.text, 'hello world');
  assert.equal(body.chat_id, 'chat-1');
});

test('Telegram downloads an http image and uploads it via sendPhoto multipart', async () => {
  const { provider, calls } = makeProvider(async (url) => {
    if (url.startsWith('https://cdn.example.com/')) {
      return {
        arrayBuffer: new TextEncoder().encode('png-bytes').buffer,
        headers: { 'content-type': 'image/png' }
      };
    }
    return { json: { ok: true, result: { message_id: 22 } } };
  });

  const result = await provider.sendMessage({
    conversation: { externalConversationId: 'chat-2' },
    text: '',
    images: [{ imageUrl: 'https://cdn.example.com/a.png', title: 'a caption' }]
  });

  assert.equal(result.messageId, '22');
  const download = calls.find((c) => c.url.startsWith('https://cdn.example.com/'));
  const photo = calls.find((c) => c.url.endsWith('/sendPhoto'));
  assert.ok(download, 'image bytes must be downloaded locally');
  assert.ok(photo, 'sendPhoto must be called');
  assert.match(String(photo.options.headers['Content-Type']), /multipart\/form-data/);
  const bodyStr = bodyToString(photo.options.body);
  assert.match(bodyStr, /name="chat_id"/);
  assert.match(bodyStr, /chat-2/);
  assert.match(bodyStr, /name="photo"/);
  assert.match(bodyStr, /name="caption"/);
  assert.match(bodyStr, /a caption/);
  // image-only (no text): no plain sendMessage call
  assert.equal(calls.some((c) => c.url.endsWith('/sendMessage')), false);
});

test('Telegram decodes a data-url image and uploads via sendPhoto without downloading', async () => {
  const { provider, calls } = makeProvider(async () => ({ json: { ok: true, result: { message_id: 33 } } }));

  const result = await provider.sendMessage({
    conversation: { externalConversationId: 'chat-3' },
    images: [{ imageUrl: 'data:image/png;base64,aGVsbG8=' }]
  });

  assert.equal(result.messageId, '33');
  const photo = calls.find((c) => c.url.endsWith('/sendPhoto'));
  assert.ok(photo);
  assert.equal(calls.length, 1, 'data url must not trigger a download');
});

test('Telegram reads a local-path image and uploads via sendPhoto', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'cligate-telegram-image-'));
  const imagePath = join(tempDir, 'sample.png');
  writeFileSync(imagePath, Buffer.from('png-binary'));

  const { provider, calls } = makeProvider(async () => ({ json: { ok: true, result: { message_id: 44 } } }));

  const result = await provider.sendMessage({
    conversation: { externalConversationId: 'chat-4' },
    images: [{ path: imagePath }]
  });

  assert.equal(result.messageId, '44');
  const photo = calls.find((c) => c.url.endsWith('/sendPhoto'));
  assert.ok(photo);
  const bodyStr = bodyToString(photo.options.body);
  assert.match(bodyStr, /filename="sample\.png"/);
});

test('Telegram sends text first and then the photo when both are present', async () => {
  const { provider, calls } = makeProvider(async (url) => {
    if (url.startsWith('https://cdn.example.com/')) {
      return { arrayBuffer: new TextEncoder().encode('img').buffer, headers: { 'content-type': 'image/jpeg' } };
    }
    return { json: { ok: true, result: { message_id: 55 } } };
  });

  await provider.sendMessage({
    conversation: { externalConversationId: 'chat-5' },
    text: 'here is the result',
    images: [{ imageUrl: 'https://cdn.example.com/b.jpg' }]
  });

  const sendMessageIdx = calls.findIndex((c) => c.url.endsWith('/sendMessage'));
  const sendPhotoIdx = calls.findIndex((c) => c.url.endsWith('/sendPhoto'));
  assert.ok(sendMessageIdx >= 0, 'text must be sent');
  assert.ok(sendPhotoIdx >= 0, 'photo must be sent');
  assert.ok(sendMessageIdx < sendPhotoIdx, 'text must precede the photo');
});

test('Telegram throws when an image-only delivery fails for all images', async () => {
  const { provider } = makeProvider(async () => ({ json: { ok: true, result: { message_id: 66 } } }));

  await assert.rejects(
    provider.sendMessage({
      conversation: { externalConversationId: 'chat-6' },
      images: [{ imageUrl: 'ftp://example.com/nope.png' }]
    }),
    /requires a readable local path, a data URL, or an http\(s\) image url/i
  );
});

test('Telegram keeps the text path intact and warns when an image is unsupported', async () => {
  const warnings = [];
  const { provider, calls } = makeProvider(async () => ({ json: { ok: true, result: { message_id: 77 } } }));
  provider.logger = { warn(message) { warnings.push(String(message || '')); } };

  const result = await provider.sendMessage({
    conversation: { externalConversationId: 'chat-7' },
    text: 'keep this text',
    images: [{ imageUrl: 'ftp://example.com/nope.png' }]
  });

  assert.equal(result.messageId, '77');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Skipping unsupported outbound image/i);
  const textCall = calls.find((c) => c.url.endsWith('/sendMessage'));
  assert.ok(textCall);
  assert.match(JSON.parse(textCall.options.body).text, /keep this text/);
});

// --- inbound image (receiving photos) --------------------------------------

test('Telegram normalizeInbound maps a photo update to a photo message with the largest file id', () => {
  const { provider } = makeProvider(async () => ({ json: { ok: true } }));
  const normalized = provider.normalizeInbound({
    update_id: 100,
    message: {
      message_id: 5,
      chat: { id: 'chat-img' },
      from: { id: 'u1', username: 'alice' },
      caption: '看这张图',
      photo: [
        { file_id: 'small', width: 90 },
        { file_id: 'large', width: 1280 }
      ]
    }
  });

  assert.ok(normalized);
  assert.equal(normalized.messageType, 'photo');
  assert.equal(normalized.metadata.fileId, 'large');
  assert.equal(normalized.text, '看这张图');
  assert.equal(normalized.externalConversationId, 'chat-img');
});

test('Telegram normalizeInbound maps an image document to a photo message', () => {
  const { provider } = makeProvider(async () => ({ json: { ok: true } }));
  const normalized = provider.normalizeInbound({
    update_id: 101,
    message: {
      message_id: 6,
      chat: { id: 'chat-doc' },
      from: { id: 'u2' },
      document: { file_id: 'doc-1', mime_type: 'image/png' }
    }
  });

  assert.ok(normalized);
  assert.equal(normalized.messageType, 'photo');
  assert.equal(normalized.metadata.fileId, 'doc-1');
});

test('Telegram normalizeInbound ignores a non-image document', () => {
  const { provider } = makeProvider(async () => ({ json: { ok: true } }));
  const normalized = provider.normalizeInbound({
    update_id: 102,
    message: {
      message_id: 7,
      chat: { id: 'chat-pdf' },
      from: { id: 'u3' },
      document: { file_id: 'pdf-1', mime_type: 'application/pdf' }
    }
  });

  assert.equal(normalized, null);
});

test('Telegram resolveInboundImage downloads the image and builds input_image data-url parts', async () => {
  const { provider, calls } = makeProvider(async (url) => {
    if (url.endsWith('/getFile')) {
      return { json: { ok: true, result: { file_path: 'photos/file_1.jpg' } } };
    }
    if (url.startsWith('https://api.telegram.org/file/bot')) {
      return { arrayBuffer: new TextEncoder().encode('img-bytes').buffer, headers: { 'content-type': 'image/png' } };
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const normalized = provider.normalizeInbound({
    update_id: 103,
    message: {
      message_id: 8,
      chat: { id: 'chat-resolve' },
      from: { id: 'u4' },
      caption: 'caption here',
      photo: [{ file_id: 'big' }]
    }
  });
  const resolved = await provider.resolveInboundImage(normalized);

  const getFileCall = calls.find((c) => c.url.endsWith('/getFile'));
  assert.ok(getFileCall, 'getFile must be called');
  assert.equal(JSON.parse(getFileCall.options.body).file_id, 'big');
  assert.ok(calls.some((c) => c.url === 'https://api.telegram.org/file/bottok-1/photos/file_1.jpg'));
  assert.ok(Array.isArray(resolved.inputParts));
  assert.deepEqual(resolved.inputParts[0], { type: 'text', text: 'caption here' });
  assert.equal(resolved.inputParts[1].type, 'input_image');
  assert.match(resolved.inputParts[1].image_url, /^data:image\/png;base64,/);
  assert.equal(resolved.inputParts[1].media_type, 'image/png');
});

test('Telegram resolveInboundImage ignores application/octet-stream and sniffs the real image MIME', async () => {
  // Regression: Telegram's file CDN serves application/octet-stream, which we
  // previously put straight into the data URL — vision models reject it.
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const { provider } = makeProvider(async (url) => {
    if (url.endsWith('/getFile')) {
      return { json: { ok: true, result: { file_path: 'photos/file.bin' } } };
    }
    if (url.startsWith('https://api.telegram.org/file/bot')) {
      return { arrayBuffer: pngBytes.buffer, headers: { 'content-type': 'application/octet-stream' } };
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const normalized = provider.normalizeInbound({
    update_id: 200,
    message: { message_id: 1, chat: { id: 'c' }, from: { id: 'u' }, photo: [{ file_id: 'f' }] }
  });
  const resolved = await provider.resolveInboundImage(normalized);

  assert.equal(resolved.inputParts[0].media_type, 'image/png');
  assert.match(resolved.inputParts[0].image_url, /^data:image\/png;base64,/);
  assert.equal(resolved.inputParts[0].image_url.includes('octet-stream'), false);
});

test('Telegram resolveInboundImage falls back to the file extension when bytes and header are unhelpful', async () => {
  const { provider } = makeProvider(async (url) => {
    if (url.endsWith('/getFile')) {
      return { json: { ok: true, result: { file_path: 'photos/file_1.jpg' } } };
    }
    if (url.startsWith('https://api.telegram.org/file/bot')) {
      return { arrayBuffer: new TextEncoder().encode('not-a-real-image').buffer, headers: { 'content-type': 'application/octet-stream' } };
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const normalized = provider.normalizeInbound({
    update_id: 201,
    message: { message_id: 2, chat: { id: 'c' }, from: { id: 'u' }, photo: [{ file_id: 'f' }] }
  });
  const resolved = await provider.resolveInboundImage(normalized);

  assert.equal(resolved.inputParts[0].media_type, 'image/jpeg');
  assert.match(resolved.inputParts[0].image_url, /^data:image\/jpeg;base64,/);
});

test('Telegram resolveInboundImage falls back to a text placeholder when the download fails', async () => {
  const warnings = [];
  const { provider } = makeProvider(async (url) => {
    if (url.endsWith('/getFile')) {
      return { ok: false, json: { ok: false, description: 'boom' } };
    }
    return { json: { ok: true } };
  });
  provider.logger = { warn(message) { warnings.push(String(message || '')); } };

  const normalized = provider.normalizeInbound({
    update_id: 104,
    message: { message_id: 9, chat: { id: 'chat-fail' }, from: { id: 'u5' }, photo: [{ file_id: 'x' }] }
  });
  const resolved = await provider.resolveInboundImage(normalized);

  assert.equal(resolved.inputParts, undefined);
  assert.match(resolved.text, /failed to download/i);
  assert.equal(warnings.length, 1);
});
