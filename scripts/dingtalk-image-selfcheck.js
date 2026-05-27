import '../tests/test-env.js';
import assert from 'node:assert/strict';

import DingTalkChannelProvider from '../src/agent-channels/providers/dingtalk-provider.js';

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

async function main() {
  const routed = [];
  const fetchCalls = [];
  const provider = new DingTalkChannelProvider({
    fetchImpl: createFetchStub(async (url, options) => {
      fetchCalls.push({ url, options });
      if (url.includes('/oauth2/accessToken')) {
        return { json: { accessToken: 'token-selfcheck' } };
      }
      if (url.includes('/robot/messageFiles/download')) {
        return {
          json: {
            downloadUrl: 'https://example.com/selfcheck-image.png',
            fileName: 'selfcheck-image.png'
          }
        };
      }
      if (url.includes('/robot/groupMessages/send')) {
        return {
          json: {
            processQueryKey: `send-${fetchCalls.length}`
          }
        };
      }
      throw new Error(`unexpected url: ${url}`);
    })
  });
  provider.settings = {
    clientId: 'app-key',
    clientSecret: 'app-secret',
    robotCode: 'robot-code',
    mode: 'webhook'
  };
  provider.router = {
    async routeInboundMessage(message) {
      routed.push(message);
      return {
        type: 'duplicate',
        message: ''
      };
    }
  };

  await provider.handleWebhook({
    msgtype: 'picture',
    msgId: 'selfcheck-msg-1',
    conversationId: 'selfcheck-conv-1',
    senderStaffId: 'selfcheck-staff-1',
    senderNick: 'selfcheck-user',
    robotCode: 'robot-code',
    content: {
      downloadCode: 'selfcheck-download-1',
      fileName: 'selfcheck-image.png',
      caption: '自检图片'
    }
  }, { skipVerification: true });

  assert.equal(routed.length, 1);
  assert.equal(routed[0].messageType, 'picture');
  assert.equal(routed[0].inputParts?.[1]?.image_url, 'https://example.com/selfcheck-image.png');

  const outbound = await provider.sendMessage({
    conversation: {
      externalConversationId: 'selfcheck-conv-2',
      metadata: {
        channelContext: {
          robotCode: 'robot-code',
          conversationType: '2',
          senderStaffId: 'selfcheck-staff-2'
        }
      }
    },
    images: [
      { imageUrl: 'https://example.com/selfcheck-out-a.png' },
      { imageUrl: 'https://example.com/selfcheck-out-b.png' }
    ]
  });

  assert.equal(outbound.messageId, `send-${fetchCalls.length}`);
  const sendCalls = fetchCalls.filter((entry) => entry.url.includes('/robot/groupMessages/send'));
  assert.equal(sendCalls.length, 2);

  const summary = {
    inboundPictureRouted: routed.length,
    outboundImageMessagesSent: sendCalls.length,
    downloadCalls: fetchCalls.filter((entry) => entry.url.includes('/robot/messageFiles/download')).length,
    tokenCalls: fetchCalls.filter((entry) => entry.url.includes('/oauth2/accessToken')).length
  };
  console.log(JSON.stringify({
    ok: true,
    summary
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error?.message || String(error)
  }, null, 2));
  process.exitCode = 1;
});
