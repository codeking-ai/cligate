import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import DingTalkChannelProvider from '../../src/agent-channels/providers/dingtalk-provider.js';
import { AgentChannelDeliverySender } from '../../src/agent-channels/delivery-sender.js';
import { ArtifactService } from '../../src/assistant-core/artifact-service.js';
import { ArtifactStore } from '../../src/assistant-core/domain/artifact-store.js';
import { TaskStore } from '../../src/assistant-core/domain/task-store.js';
import { ExecutionStore } from '../../src/assistant-core/domain/execution-store.js';
import { ProjectStore } from '../../src/assistant-core/domain/project-store.js';

function createFetchStub(handler) {
  return async (url, options = {}) => {
    const response = await handler(String(url), options);
    return {
      ok: response.ok !== false,
      status: response.status || (response.ok === false ? 500 : 200),
      async json() {
        return response.json ?? {};
      }
    };
  };
}

function createProviderFixture(fetchHandler) {
  const routes = [];
  const provider = new DingTalkChannelProvider({
    fetchImpl: createFetchStub(fetchHandler)
  });
  provider.settings = {
    clientId: 'app-key',
    clientSecret: 'app-secret',
    robotCode: 'robot-code',
    mode: 'webhook'
  };
  provider.router = {
    async routeInboundMessage(message) {
      routes.push(message);
      return {
        type: 'duplicate',
        message: ''
      };
    }
  };
  return {
    provider,
    routes
  };
}

test('DingTalk provider normalizes picture webhook into inputParts for assistant', async () => {
  const { provider, routes } = createProviderFixture(async (url) => {
    if (url.includes('/oauth2/accessToken')) {
      return {
        json: { accessToken: 'token-1' }
      };
    }
    if (url.includes('/robot/messageFiles/download')) {
      return {
        json: {
          downloadUrl: 'https://example.com/dingtalk/image-1.png',
          fileName: 'test-image.png'
        }
      };
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const response = await provider.handleWebhook({
    msgtype: 'picture',
    msgId: 'msg-1',
    conversationId: 'conv-1',
    senderStaffId: 'staff-1',
    senderNick: 'Alice',
    robotCode: 'robot-code',
    content: {
      downloadCode: 'download-1',
      fileName: 'test-image.png',
      caption: '看下这张图'
    }
  }, { skipVerification: true });

  assert.equal(response.status, 200);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].messageType, 'picture');
  assert.equal(routes[0].text, '[DingTalk image]');
  assert.deepEqual(routes[0].inputParts, [
    { type: 'text', text: '看下这张图' },
    {
      type: 'input_image',
      image_url: 'https://example.com/dingtalk/image-1.png',
      media_type: 'image/png'
    }
  ]);
});

test('DingTalk provider supports content JSON string and picture aliases', async () => {
  const { provider, routes } = createProviderFixture(async (url) => {
    if (url.includes('/oauth2/accessToken')) {
      return {
        json: { accessToken: 'token-2' }
      };
    }
    if (url.includes('/robot/messageFiles/download')) {
      return {
        json: {
          download_url: 'https://example.com/dingtalk/image-2.jpg',
          file_name: 'test-image.jpg'
        }
      };
    }
    throw new Error(`unexpected url: ${url}`);
  });

  await provider.handleWebhook({
    msgType: 'picture',
    messageId: 'msg-2',
    openConversationId: 'conv-2',
    userId: 'staff-2',
    senderName: 'Bob',
    content: JSON.stringify({
      picDownloadCode: 'download-2',
      file_name: 'test-image.jpg',
      title: '请识别图片内容'
    })
  }, { skipVerification: true });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].externalConversationId, 'conv-2');
  assert.equal(routes[0].externalUserId, 'staff-2');
  assert.deepEqual(routes[0].inputParts, [
    { type: 'text', text: '请识别图片内容' },
    {
      type: 'input_image',
      image_url: 'https://example.com/dingtalk/image-2.jpg',
      media_type: 'image/jpeg'
    }
  ]);
});

test('DingTalk provider keeps text-only flow compatible', async () => {
  const { provider, routes } = createProviderFixture(async () => {
    throw new Error('text-only webhook should not call fetch');
  });

  await provider.handleWebhook({
    msgtype: 'text',
    msgId: 'msg-3',
    conversationId: 'conv-3',
    senderStaffId: 'staff-3',
    text: {
      content: '继续处理这个任务'
    }
  }, { skipVerification: true });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].messageType, 'text');
  assert.equal(routes[0].text, '继续处理这个任务');
  assert.equal(Array.isArray(routes[0].inputParts), false);
});

test('DingTalk provider sendMessage sends image when only image is present', async () => {
  const calls = [];
  const provider = new DingTalkChannelProvider({
    fetchImpl: createFetchStub(async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/oauth2/accessToken')) {
        return { json: { accessToken: 'token-send' } };
      }
      return { json: { processQueryKey: 'out-1' } };
    })
  });
  provider.settings = {
    clientId: 'app-key',
    clientSecret: 'app-secret',
    robotCode: 'robot-code'
  };

  const result = await provider.sendMessage({
    conversation: {
      externalConversationId: 'conv-send-1',
      metadata: {
        channelContext: {
          robotCode: 'robot-code',
          conversationType: '2',
          senderStaffId: 'staff-send-1'
        }
      }
    },
    text: '',
    images: [{
      imageUrl: 'https://example.com/out-image.png'
    }]
  });

  assert.equal(result.messageId, 'out-1');
  const lastCall = calls[calls.length - 1];
  const body = JSON.parse(String(lastCall.options.body || '{}'));
  assert.equal(body.msgKey, 'sampleImageMsg');
  assert.match(String(body.msgParam || ''), /https:\/\/example\.com\/out-image\.png/);
});

test('DingTalk provider sendMessage rejects image delivery in webhook mode', async () => {
  const provider = new DingTalkChannelProvider({
    fetchImpl: createFetchStub(async () => {
      throw new Error('webhook mode image delivery should fail before fetch');
    })
  });
  provider.settings = {
    mode: 'webhook',
    clientId: 'app-key',
    clientSecret: 'app-secret',
    robotCode: 'robot-code'
  };

  await assert.rejects(
    provider.sendMessage({
      conversation: {
        externalConversationId: 'conv-send-webhook-1',
        metadata: {
          channelContext: {
            robotCode: 'robot-code',
            conversationType: '2',
            senderStaffId: 'staff-send-webhook-1',
            sessionWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=test'
          }
        }
      },
      images: [{
        imageUrl: 'https://example.com/out-image-webhook.png'
      }]
    }),
    /webhook mode/i
  );
});

test('DingTalk provider sendMessage sends text first and then image when text and image are mixed', async () => {
  const calls = [];
  const provider = new DingTalkChannelProvider({
    fetchImpl: createFetchStub(async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/oauth2/accessToken')) {
        return { json: { accessToken: 'token-send-2' } };
      }
      return { json: { processQueryKey: 'out-2' } };
    })
  });
  provider.settings = {
    clientId: 'app-key',
    clientSecret: 'app-secret',
    robotCode: 'robot-code'
  };

  await provider.sendMessage({
    conversation: {
      externalConversationId: 'conv-send-2',
      metadata: {
        channelContext: {
          robotCode: 'robot-code',
          conversationType: '2',
          senderStaffId: 'staff-send-2'
        }
      }
    },
    text: '这是一张处理结果图',
    images: [{
      imageUrl: 'https://example.com/out-image-2.png'
    }]
  });

  const lastCall = calls[calls.length - 1];
  const textCall = calls.find((entry) => entry.url.includes('/robot/groupMessages/send') && String(entry.options.body || '').includes('sampleText'));
  const imageCall = calls.find((entry) => entry.url.includes('/robot/groupMessages/send') && String(entry.options.body || '').includes('sampleImageMsg'));
  assert.ok(textCall);
  assert.ok(imageCall);
  const textBody = JSON.parse(String(textCall.options.body || '{}'));
  const imageBody = JSON.parse(String(imageCall.options.body || '{}'));
  assert.equal(textBody.msgKey, 'sampleText');
  assert.match(String(textBody.msgParam || ''), /这是一张处理结果图/);
  assert.equal(imageBody.msgKey, 'sampleImageMsg');
  assert.match(String(imageBody.msgParam || ''), /https:\/\/example\.com\/out-image-2\.png/);
  assert.equal(lastCall, imageCall);
});

test('DingTalk provider sendMessage sends multiple http images sequentially when no text is present', async () => {
  const calls = [];
  const provider = new DingTalkChannelProvider({
    fetchImpl: createFetchStub(async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/oauth2/accessToken')) {
        return { json: { accessToken: 'token-send-3' } };
      }
      return { json: { processQueryKey: `out-${calls.length}` } };
    })
  });
  provider.settings = {
    clientId: 'app-key',
    clientSecret: 'app-secret',
    robotCode: 'robot-code'
  };

  const result = await provider.sendMessage({
    conversation: {
      externalConversationId: 'conv-send-3',
      metadata: {
        channelContext: {
          robotCode: 'robot-code',
          conversationType: '2',
          senderStaffId: 'staff-send-3'
        }
      }
    },
    images: [
      { imageUrl: 'https://example.com/out-image-3a.png' },
      { imageUrl: 'https://example.com/out-image-3b.png' }
    ]
  });

  assert.equal(result.messageId, 'out-3');
  const imageCalls = calls.filter((entry) => entry.url.includes('/robot/groupMessages/send'));
  assert.equal(imageCalls.length, 2);
  const bodies = imageCalls.map((entry) => JSON.parse(String(entry.options.body || '{}')));
  assert.match(String(bodies[0].msgParam || ''), /out-image-3a\.png/);
  assert.match(String(bodies[1].msgParam || ''), /out-image-3b\.png/);
});

test('DingTalk provider sendMessage uploads data-url images and sends returned media id', async () => {
  const calls = [];
  const provider = new DingTalkChannelProvider({
    fetchImpl: createFetchStub(async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/oauth2/accessToken')) {
        return { json: { accessToken: 'token-send-data' } };
      }
      if (url.includes('/media/upload')) {
        return { json: { errcode: 0, media_id: 'media-data-1' } };
      }
      return { json: { processQueryKey: 'out-data-1' } };
    })
  });
  provider.settings = {
    mode: 'stream',
    clientId: 'app-key',
    clientSecret: 'app-secret',
    robotCode: 'robot-code'
  };

  const result = await provider.sendMessage({
    conversation: {
      externalConversationId: 'conv-send-data-1',
      metadata: {
        channelContext: {
          robotCode: 'robot-code',
          conversationType: '2',
          senderStaffId: 'staff-send-data-1'
        }
      }
    },
    images: [{
      imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA'
    }]
  });

  assert.equal(result.messageId, 'out-data-1');
  const uploadCall = calls.find((entry) => entry.url.includes('/media/upload'));
  assert.ok(uploadCall);
  const sendCall = calls.find((entry) => entry.url.includes('/robot/groupMessages/send'));
  assert.ok(sendCall);
  const body = JSON.parse(String(sendCall.options.body || '{}'));
  assert.equal(body.msgKey, 'sampleImageMsg');
  assert.match(String(body.msgParam || ''), /media-data-1/);
});

test('DingTalk provider sendMessage uploads local-path images and sends returned media id', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'cligate-dingtalk-image-'));
  const imagePath = join(tempDir, 'sample.png');
  writeFileSync(imagePath, Buffer.from('png-binary'));

  const calls = [];
  const provider = new DingTalkChannelProvider({
    fetchImpl: createFetchStub(async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/oauth2/accessToken')) {
        return { json: { accessToken: 'token-send-path' } };
      }
      if (url.includes('/media/upload')) {
        return { json: { errcode: 0, media_id: 'media-path-1' } };
      }
      return { json: { processQueryKey: 'out-path-1' } };
    })
  });
  provider.settings = {
    mode: 'stream',
    clientId: 'app-key',
    clientSecret: 'app-secret',
    robotCode: 'robot-code'
  };

  const result = await provider.sendMessage({
    conversation: {
      externalConversationId: 'conv-send-path-1',
      metadata: {
        channelContext: {
          robotCode: 'robot-code',
          conversationType: '2',
          senderStaffId: 'staff-send-path-1'
        }
      }
    },
    images: [{
      path: imagePath
    }]
  });

  assert.equal(result.messageId, 'out-path-1');
  const uploadCall = calls.find((entry) => entry.url.includes('/media/upload'));
  assert.ok(uploadCall);
  const sendCall = calls.find((entry) => entry.url.includes('/robot/groupMessages/send'));
  assert.ok(sendCall);
  const body = JSON.parse(String(sendCall.options.body || '{}'));
  assert.match(String(body.msgParam || ''), /media-path-1/);
});

test('DingTalk provider sendMessage rejects image-only delivery when all images are unsupported', async () => {
  const provider = new DingTalkChannelProvider({
    fetchImpl: createFetchStub(async () => {
      throw new Error('unsupported image should fail before fetch');
    })
  });
  provider.settings = {
    clientId: 'app-key',
    clientSecret: 'app-secret',
    robotCode: 'robot-code'
  };
  provider.logger = {
    warn() {}
  };

  await assert.rejects(
    provider.sendMessage({
      conversation: {
        externalConversationId: 'conv-send-4',
        metadata: {
          channelContext: {
            robotCode: 'robot-code',
            conversationType: '2',
            senderStaffId: 'staff-send-4'
          }
        }
      },
      images: [
        { imageUrl: 'ftp://example.com/test.png' },
        { imageUrl: 'file:///tmp/test.png' }
      ]
    }),
    /requires a mediaId, an http\(s\) photoURL, a data URL, or a readable local image path/i
  );
});

test('DingTalk provider sendMessage ignores unsupported image and keeps text-only path intact', async () => {
  const calls = [];
  const warnings = [];
  const provider = new DingTalkChannelProvider({
    fetchImpl: createFetchStub(async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/oauth2/accessToken')) {
        return { json: { accessToken: 'token-send-5' } };
      }
      return { json: { processQueryKey: 'out-5' } };
    })
  });
  provider.settings = {
    clientId: 'app-key',
    clientSecret: 'app-secret',
    robotCode: 'robot-code'
  };
  provider.logger = {
    warn(message) {
      warnings.push(String(message || ''));
    }
  };

  await provider.sendMessage({
    conversation: {
      externalConversationId: 'conv-send-5',
      metadata: {
        channelContext: {
          robotCode: 'robot-code',
          conversationType: '2',
          senderStaffId: 'staff-send-5'
        }
      }
    },
    text: '保留文字结果',
    images: [
      { imageUrl: 'data:image/png;base64,abc123' }
    ]
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Skipping 1 unsupported outbound image/i);
  const lastCall = calls[calls.length - 1];
  const body = JSON.parse(String(lastCall.options.body || '{}'));
  assert.equal(body.msgKey, 'sampleText');
  assert.match(String(body.msgParam || ''), /保留文字结果/);
});

test('delivery sender resolves assistant image artifacts into outbound images', async () => {
  const artifactService = new ArtifactService({
    artifactStore: new ArtifactStore(),
    taskStore: new TaskStore(),
    executionStore: new ExecutionStore(),
    projectStore: new ProjectStore()
  });
  const artifact = artifactService.createArtifact({
    kind: 'image',
    source: 'view_image',
    conversationId: 'conv-artifact-1',
    title: 'generated image',
    imageUrl: 'https://example.com/artifact-image.png',
    mediaType: 'image/png'
  });

  const providerCalls = [];
  const sender = new AgentChannelDeliverySender({
    registry: {
      get() {
        return {
          async sendMessage(input) {
            providerCalls.push(input);
            return { messageId: 'delivery-1' };
          }
        };
      }
    },
    deliveryStore: {
      saveOutbound(record) {
        return { id: 'delivery-store-1', ...record };
      }
    },
    artifactService,
    stateCoordinator: {
      recordDeliveryEpisode() {}
    }
  });

  await sender.send({
    conversation: {
      id: 'conv-artifact-1',
      channel: 'dingtalk',
      accountId: 'default',
      externalConversationId: 'ext-conv-artifact-1',
      metadata: {
        channelContext: {}
      }
    },
    channel: 'dingtalk',
    payload: {
      text: '',
      artifactRefs: [artifact.id]
    },
    message: {
      text: ''
    }
  });

  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].text, '');
  assert.deepEqual(providerCalls[0].images, [{
    imageUrl: 'https://example.com/artifact-image.png',
    mediaType: 'image/png',
    title: 'generated image',
    artifactId: artifact.id
  }]);
});
