import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import FeishuChannelProvider from '../../src/agent-channels/providers/feishu-provider.js';

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

// Default REST-mode handler: token + image upload + message send.
function defaultHandler(messageId = 'msg-out') {
  return async (url) => {
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      return { json: { code: 0, tenant_access_token: 'tok', expire: 7200 } };
    }
    if (url.includes('/im/v1/images')) {
      return { json: { code: 0, data: { image_key: 'img_key_1' } } };
    }
    if (url.includes('/im/v1/messages')) {
      return { json: { code: 0, data: { message_id: messageId } } };
    }
    throw new Error(`unexpected url: ${url}`);
  };
}

function makeProvider(handler) {
  const calls = [];
  const provider = new FeishuChannelProvider({
    fetchImpl: createFetchStub(async (url, options) => {
      calls.push({ url, options });
      return handler(url, options);
    })
  });
  provider.settings = { appId: 'app-id', appSecret: 'app-secret', mode: 'webhook' };
  provider.logger = { warn() {} };
  return { provider, calls };
}

test('Feishu text-only delivery (REST mode) sends a text message and never uploads an image', async () => {
  const { provider, calls } = makeProvider(defaultHandler('text-msg-1'));

  const result = await provider.sendMessage({
    conversation: { externalConversationId: 'chat-1' },
    text: 'hello feishu'
  });

  assert.equal(result.messageId, 'text-msg-1');
  assert.equal(calls.some((c) => c.url.includes('/im/v1/images')), false);
  const messageCall = calls.find((c) => c.url.includes('/im/v1/messages'));
  assert.ok(messageCall);
  const body = JSON.parse(messageCall.options.body);
  assert.equal(body.msg_type, 'text');
  assert.match(body.content, /hello feishu/);
});

test('Feishu downloads an http image, uploads to /im/v1/images, then sends an image message', async () => {
  const { provider, calls } = makeProvider(async (url) => {
    if (url.startsWith('https://cdn.example.com/')) {
      return { arrayBuffer: new TextEncoder().encode('png-bytes').buffer, headers: { 'content-type': 'image/png' } };
    }
    return defaultHandler('image-msg-1')(url);
  });

  const result = await provider.sendMessage({
    conversation: { externalConversationId: 'chat-2' },
    text: '',
    images: [{ imageUrl: 'https://cdn.example.com/a.png' }]
  });

  assert.equal(result.messageId, 'image-msg-1');
  const download = calls.find((c) => c.url.startsWith('https://cdn.example.com/'));
  const upload = calls.find((c) => c.url.includes('/im/v1/images'));
  const messageCall = calls.find((c) => c.url.includes('/im/v1/messages'));
  assert.ok(download, 'image bytes must be downloaded locally');
  assert.ok(upload, 'image must be uploaded to obtain an image_key');
  assert.match(String(upload.options.headers['Content-Type']), /multipart\/form-data/);
  const uploadBody = bodyToString(upload.options.body);
  assert.match(uploadBody, /name="image_type"/);
  assert.match(uploadBody, /message/);
  assert.match(uploadBody, /name="image"/);
  assert.ok(messageCall);
  const messageBody = JSON.parse(messageCall.options.body);
  assert.equal(messageBody.msg_type, 'image');
  assert.match(messageBody.content, /img_key_1/);
});

test('Feishu decodes a data-url image and uploads without downloading', async () => {
  const { provider, calls } = makeProvider(defaultHandler('image-msg-2'));

  const result = await provider.sendMessage({
    conversation: { externalConversationId: 'chat-3' },
    images: [{ imageUrl: 'data:image/png;base64,aGVsbG8=' }]
  });

  assert.equal(result.messageId, 'image-msg-2');
  const upload = calls.find((c) => c.url.includes('/im/v1/images'));
  assert.ok(upload);
});

test('Feishu reads a local-path image and uploads via /im/v1/images', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'cligate-feishu-image-'));
  const imagePath = join(tempDir, 'sample.png');
  writeFileSync(imagePath, Buffer.from('png-binary'));

  const { provider, calls } = makeProvider(defaultHandler('image-msg-3'));

  const result = await provider.sendMessage({
    conversation: { externalConversationId: 'chat-4' },
    images: [{ path: imagePath }]
  });

  assert.equal(result.messageId, 'image-msg-3');
  const upload = calls.find((c) => c.url.includes('/im/v1/images'));
  assert.ok(upload);
  assert.match(bodyToString(upload.options.body), /filename="sample\.png"/);
});

test('Feishu sends text first and then the image when both are present', async () => {
  const { provider, calls } = makeProvider(async (url) => {
    if (url.startsWith('https://cdn.example.com/')) {
      return { arrayBuffer: new TextEncoder().encode('img').buffer, headers: { 'content-type': 'image/jpeg' } };
    }
    return defaultHandler('mixed-1')(url);
  });

  await provider.sendMessage({
    conversation: { externalConversationId: 'chat-5' },
    text: 'result attached',
    images: [{ imageUrl: 'https://cdn.example.com/b.jpg' }]
  });

  const messageCalls = calls.filter((c) => c.url.includes('/im/v1/messages'));
  assert.equal(messageCalls.length, 2, 'one text message and one image message');
  const first = JSON.parse(messageCalls[0].options.body);
  const second = JSON.parse(messageCalls[1].options.body);
  assert.equal(first.msg_type, 'text');
  assert.match(first.content, /result attached/);
  assert.equal(second.msg_type, 'image');
});

test('Feishu throws when an image-only delivery fails for all images', async () => {
  const { provider } = makeProvider(defaultHandler());

  await assert.rejects(
    provider.sendMessage({
      conversation: { externalConversationId: 'chat-6' },
      images: [{ imageUrl: 'ftp://example.com/nope.png' }]
    }),
    /requires a readable local path, a data URL, or an http\(s\) image url/i
  );
});

// --- inbound image (receiving images) --------------------------------------

function imageEventPayload({ imageKey = 'img_v2_abc', messageId = 'om_msg_1', chatId = 'oc_chat_1' } = {}) {
  return {
    header: { event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: 'ou_user_1' }, sender_type: 'user' },
      message: {
        message_id: messageId,
        chat_id: chatId,
        message_type: 'image',
        content: JSON.stringify({ image_key: imageKey })
      }
    }
  };
}

test('Feishu normalizeInbound maps an image message to an image message with the image key', () => {
  const { provider } = makeProvider(defaultHandler());
  const normalized = provider.normalizeInbound(imageEventPayload({ imageKey: 'img_v2_xyz', messageId: 'om_9' }));

  assert.ok(normalized);
  assert.equal(normalized.messageType, 'image');
  assert.equal(normalized.metadata.imageKey, 'img_v2_xyz');
  assert.equal(normalized.metadata.messageId, 'om_9');
  assert.equal(normalized.externalConversationId, 'oc_chat_1');
});

test('Feishu handleWebhook downloads an inbound image into input_image data-url parts and routes it', async () => {
  const routed = [];
  const { provider, calls } = makeProvider(async (url, options) => {
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      return { json: { code: 0, tenant_access_token: 'tok', expire: 7200 } };
    }
    if (url.includes('/resources/')) {
      return { arrayBuffer: new TextEncoder().encode('feishu-img').buffer, headers: { 'content-type': 'image/png' } };
    }
    throw new Error(`unexpected url: ${url} ${options?.method || ''}`);
  });
  provider.router = {
    async routeInboundMessage(message) {
      routed.push(message);
      return { type: 'duplicate', message: '' };
    }
  };

  const res = await provider.handleWebhook(imageEventPayload({ imageKey: 'img_key_in', messageId: 'om_in_1' }));

  assert.equal(res.status, 200);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].messageType, 'image');
  assert.equal(routed[0].text, '[Feishu image]');
  assert.ok(Array.isArray(routed[0].inputParts));
  assert.equal(routed[0].inputParts[0].type, 'input_image');
  assert.match(routed[0].inputParts[0].image_url, /^data:image\/png;base64,/);
  const download = calls.find((c) => c.url.includes('/resources/'));
  assert.ok(download, 'resource download must be called');
  assert.match(download.url, /\/messages\/om_in_1\/resources\/img_key_in\?type=image/);
});

test('Feishu inbound image ignores application/octet-stream and sniffs the real image MIME', async () => {
  // Regression: Feishu's resource API serves application/octet-stream, which we
  // previously put straight into the data URL — vision models reject it.
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const routed = [];
  const { provider } = makeProvider(async (url) => {
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      return { json: { code: 0, tenant_access_token: 'tok', expire: 7200 } };
    }
    if (url.includes('/resources/')) {
      return { arrayBuffer: pngBytes.buffer, headers: { 'content-type': 'application/octet-stream' } };
    }
    throw new Error(`unexpected url: ${url}`);
  });
  provider.router = {
    async routeInboundMessage(message) {
      routed.push(message);
      return { type: 'duplicate', message: '' };
    }
  };

  await provider.handleWebhook(imageEventPayload());

  assert.equal(routed[0].inputParts[0].media_type, 'image/png');
  assert.match(routed[0].inputParts[0].image_url, /^data:image\/png;base64,/);
  assert.equal(routed[0].inputParts[0].image_url.includes('octet-stream'), false);
});

test('Feishu inbound image falls back to image/jpeg when bytes and header are unhelpful', async () => {
  const routed = [];
  const { provider } = makeProvider(async (url) => {
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      return { json: { code: 0, tenant_access_token: 'tok', expire: 7200 } };
    }
    if (url.includes('/resources/')) {
      return { arrayBuffer: new TextEncoder().encode('not-a-real-image').buffer, headers: { 'content-type': 'application/octet-stream' } };
    }
    throw new Error(`unexpected url: ${url}`);
  });
  provider.router = {
    async routeInboundMessage(message) {
      routed.push(message);
      return { type: 'duplicate', message: '' };
    }
  };

  await provider.handleWebhook(imageEventPayload());

  assert.equal(routed[0].inputParts[0].media_type, 'image/jpeg');
});

test('Feishu handleWebhook falls back to a text placeholder when the image download fails', async () => {
  const routed = [];
  const warnings = [];
  const { provider } = makeProvider(async (url) => {
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      return { json: { code: 0, tenant_access_token: 'tok', expire: 7200 } };
    }
    if (url.includes('/resources/')) {
      return { ok: false, json: { code: 1, msg: 'boom' } };
    }
    throw new Error(`unexpected url: ${url}`);
  });
  provider.logger = { warn(message) { warnings.push(String(message || '')); } };
  provider.router = {
    async routeInboundMessage(message) {
      routed.push(message);
      return { type: 'duplicate', message: '' };
    }
  };

  await provider.handleWebhook(imageEventPayload());

  assert.equal(routed.length, 1);
  assert.equal(routed[0].inputParts, undefined);
  assert.match(routed[0].text, /failed to download/i);
  assert.equal(warnings.length, 1);
});

test('Feishu websocket mode sends text via SDK but still uploads images via REST', async () => {
  const sdkCalls = [];
  const { provider, calls } = makeProvider(defaultHandler('ws-image-1'));
  provider.sdkClient = {
    im: {
      v1: {
        message: {
          async create(input) {
            sdkCalls.push(input);
            return { code: 0, data: { message_id: 'sdk-text-1' } };
          }
        }
      }
    }
  };

  await provider.sendMessage({
    conversation: { externalConversationId: 'chat-7' },
    text: 'via sdk',
    images: [{ imageUrl: 'data:image/png;base64,aGVsbG8=' }]
  });

  assert.equal(sdkCalls.length, 1, 'text goes through the SDK in websocket mode');
  assert.equal(sdkCalls[0].data.msg_type, 'text');
  const upload = calls.find((c) => c.url.includes('/im/v1/images'));
  const imageMessage = calls.find((c) => c.url.includes('/im/v1/messages'));
  assert.ok(upload, 'image upload still goes through REST');
  assert.ok(imageMessage);
  assert.equal(JSON.parse(imageMessage.options.body).msg_type, 'image');
});
