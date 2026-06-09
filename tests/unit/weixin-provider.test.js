import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import WeixinChannelProvider from '../../src/agent-channels/providers/weixin-provider.js';
import { WeixinAccountStore, normalizeWeixinAccountId } from '../../src/agent-channels/providers/weixin/account-store.js';
import { MessageItemType, WeixinClient } from '../../src/agent-channels/providers/weixin/client.js';
import { WeixinLoginService } from '../../src/agent-channels/providers/weixin/login-service.js';

function createTempStore() {
  return new WeixinAccountStore({
    stateDir: mkdtempSync(join(tmpdir(), 'cligate-weixin-store-'))
  });
}

function createFakeClient(overrides = {}) {
  const calls = [];
  const client = {
    calls,
    async notifyStart(account) {
      calls.push({ method: 'notifyStart', account });
      return {};
    },
    async notifyStop(account) {
      calls.push({ method: 'notifyStop', account });
      return {};
    },
    async getUpdates(account, cursor, timeoutMs) {
      calls.push({ method: 'getUpdates', account, cursor, timeoutMs });
      return {
        ret: 0,
        get_updates_buf: 'cursor-next',
        msgs: []
      };
    },
    async sendMessage(payload) {
      calls.push({ method: 'sendMessage', payload });
      return { messageId: `out-${calls.length}` };
    },
    ...overrides
  };
  return client;
}

test('normalizeWeixinAccountId keeps OpenClaw-compatible lowercase safe ids', () => {
  assert.equal(normalizeWeixinAccountId('ABC@IM.WECHAT'), 'abc-im-wechat');
  assert.equal(normalizeWeixinAccountId('__proto__'), 'default');
  assert.equal(normalizeWeixinAccountId('safe_id'), 'safe_id');
});

test('WeixinChannelProvider start fails without a bound local token', async () => {
  const provider = new WeixinChannelProvider({
    client: createFakeClient(),
    accountStore: createTempStore()
  });

  const result = await provider.start({
    settings: {
      enabled: true,
      mode: 'polling',
      accountId: 'wx-account'
    },
    router: {},
    logger: { warn() {} }
  });

  assert.equal(result.started, false);
  assert.match(result.reason, /token is not available|scan QR/i);
});

test('WeixinChannelProvider normalizes text messages and ignores bot messages during polling', async () => {
  const store = createTempStore();
  store.saveAccount('wx-account', { token: 'token-1', baseUrl: 'https://wx.example.test' });
  const routed = [];
  const client = createFakeClient({
    async getUpdates(account, cursor, timeoutMs) {
      client.calls.push({ method: 'getUpdates', account, cursor, timeoutMs });
      return {
        ret: 0,
        get_updates_buf: 'cursor-2',
        msgs: [
          {
            message_id: 'msg-user-1',
            from_user_id: 'user-1',
            context_token: 'ctx-1',
            item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'hello from wechat' } }]
          },
          {
            message_id: 'msg-bot-1',
            message_type: 2,
            from_user_id: 'user-1',
            item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'bot echo' } }]
          }
        ]
      };
    }
  });
  const provider = new WeixinChannelProvider({ client, accountStore: store });
  provider.instanceId = 'default';
  await provider.start({
    settings: {
      enabled: true,
      mode: 'polling',
      accountId: 'wx-account',
      defaultRuntimeProvider: 'codex',
      cwd: 'D:\\work',
      requirePairing: true
    },
    router: {
      async routeInboundMessage(message, options) {
        routed.push({ message, options });
        return { type: 'assistant_response', message: 'reply from cligate' };
      }
    },
    logger: { warn() {} }
  });

  const processed = await provider.pollOnce();
  await provider.stop();

  assert.equal(processed, 1);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].message.channel, 'weixin');
  assert.equal(routed[0].message.externalConversationId, 'user-1');
  assert.equal(routed[0].message.text, 'hello from wechat');
  assert.equal(routed[0].options.defaultRuntimeProvider, 'codex');
  assert.equal(routed[0].options.cwd, 'D:\\work');
  assert.equal(routed[0].options.requirePairing, true);
  assert.equal(store.readSyncCursor('wx-account'), 'cursor-2');
  assert.equal(store.getContextToken('wx-account', 'user-1'), 'ctx-1');

  const send = client.calls.find((call) => call.method === 'sendMessage');
  assert.ok(send);
  assert.equal(send.payload.to, 'user-1');
  assert.equal(send.payload.text, 'reply from cligate');
  assert.equal(send.payload.contextToken, 'ctx-1');
});

test('WeixinChannelProvider sendMessage requires a target conversation', async () => {
  const store = createTempStore();
  store.saveAccount('wx-account', { token: 'token-1' });
  const provider = new WeixinChannelProvider({
    client: createFakeClient(),
    accountStore: store
  });
  provider.settings = { accountId: 'wx-account' };

  await assert.rejects(
    provider.sendMessage({ conversation: {}, text: 'hello' }),
    /recipient is missing/i
  );
});

test('WeixinLoginService renders QR payload as a browser-displayable data URL', async () => {
  const service = new WeixinLoginService({
    accountStore: createTempStore(),
    client: {
      async fetchQRCode() {
        return {
          qrcode: 'qr-token-1',
          qrcode_img_content: 'https://weixin.example.test/scan?token=qr-token-1'
        };
      }
    }
  });

  const result = await service.startLogin({ force: true });

  assert.equal(result.ok, true);
  assert.match(result.url, /^data:image\/png;base64,/);
  assert.equal(result.qrDataUrl, result.url);
  assert.equal(result.qrValue, 'https://weixin.example.test/scan?token=qr-token-1');
  assert.equal(result.qrcode, 'qr-token-1');
});

test('WeixinClient fails clearly when the WeChat package is not installed', () => {
  const client = new WeixinClient({
    packageInfo: { version: '0.0.0', appId: '' }
  });

  assert.throws(
    () => client.buildCommonHeaders(),
    /npm install|@tencent-weixin\/openclaw-weixin/i
  );
});

test('WeixinLoginService treats binded_redirect as success only with a stored local token', async () => {
  const store = createTempStore();
  store.saveAccount('wx-account', { token: 'token-1' });
  const service = new WeixinLoginService({
    accountStore: store,
    client: {
      async fetchQRCode() {
        return {
          qrcode: 'qr-token-1',
          qrcode_img_content: 'https://weixin.example.test/scan?token=qr-token-1'
        };
      },
      async pollQRCodeStatus() {
        return { status: 'binded_redirect' };
      }
    }
  });

  const started = await service.startLogin({ force: true, accountId: 'wx-account' });
  const result = await service.waitForLogin({ sessionKey: started.sessionKey, timeoutMs: 1000 });

  assert.equal(result.connected, true);
  assert.equal(result.alreadyConnected, true);
  assert.equal(result.accountId, 'wx-account');
});

test('WeixinLoginService does not create a fake account on binded_redirect without a stored token', async () => {
  const service = new WeixinLoginService({
    accountStore: createTempStore(),
    client: {
      async fetchQRCode() {
        return {
          qrcode: 'qr-token-1',
          qrcode_img_content: 'https://weixin.example.test/scan?token=qr-token-1'
        };
      },
      async pollQRCodeStatus() {
        return { status: 'binded_redirect' };
      }
    }
  });

  const started = await service.startLogin({ force: true });
  const result = await service.waitForLogin({ sessionKey: started.sessionKey, timeoutMs: 1000 });

  assert.equal(result.connected, false);
  assert.equal(result.alreadyConnected, true);
  assert.match(result.message, /no local token|bind again/i);
});
