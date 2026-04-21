import test from 'node:test';
import assert from 'node:assert/strict';

import agentChannelConversationStore from '../../src/agent-channels/conversation-store.js';
import agentChannelManager from '../../src/agent-channels/manager.js';
import agentChannelPairingStore from '../../src/agent-channels/pairing-store.js';
import {
  handleCreateAgentChannelInstance,
  handleGetAgentChannelCatalog,
  handleGetAgentChannelSettings,
  handleListAgentChannelConversations,
  handleListAgentChannelProviders,
  handleUpdateAgentChannelSettings
} from '../../src/routes/agent-channels-route.js';

function mockRes() {
  return {
    _status: 200,
    _body: null,
    status(code) {
      this._status = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    }
  };
}

function mockReq({ body = {}, params = {}, query = {} } = {}) {
  return { body, params, query };
}

function withOverrides(items, fn) {
  const originals = items.map(({ target, key, value }) => {
    const original = target[key];
    target[key] = value;
    return { target, key, original };
  });

  const restore = () => {
    for (const item of originals) {
      item.target[item.key] = item.original;
    }
  };

  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

test('agent channel route lists provider statuses from manager', async () => {
  await withOverrides([
    {
      target: agentChannelManager,
      key: 'getProviderStatuses',
      value: () => [{ id: 'telegram', label: 'Telegram', configFields: ['enabled'], status: { running: true } }]
    }
  ], async () => {
    const res = mockRes();
    handleListAgentChannelProviders({}, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(res._body.providers[0].id, 'telegram');
    assert.equal(res._body.providers[0].label, 'Telegram');
    assert.deepEqual(res._body.providers[0].configFields, ['enabled']);
  });
});

test('agent channel route decorates conversations with pairing status', async () => {
  await withOverrides([
    {
      target: agentChannelConversationStore,
      key: 'list',
      value: () => [{
        id: 'conv_1',
        channel: 'telegram',
        accountId: 'default',
        externalConversationId: 'chat_1',
        externalUserId: 'user_1'
      }]
    },
    {
      target: agentChannelPairingStore,
      key: 'get',
      value: () => ({ status: 'pending', code: 'PAIR1234', approvedAt: null })
    }
  ], async () => {
    const res = mockRes();
    handleListAgentChannelConversations(mockReq({ query: { limit: 10 } }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.conversations[0].pairingStatus, 'pending');
    assert.equal(res._body.conversations[0].pairingCode, 'PAIR1234');
  });
});

test('agent channel route creates channel instance through manager', async () => {
  await withOverrides([
    {
      target: agentChannelManager,
      key: 'createChannelInstance',
      value: () => ({ id: 'bot-2', enabled: true, botToken: 'token' })
    },
    {
      target: agentChannelManager,
      key: 'refresh',
      value: async () => [{ id: 'telegram', status: { running: true } }]
    }
  ], async () => {
    const res = mockRes();
    await handleCreateAgentChannelInstance(
      mockReq({ params: { channel: 'telegram' }, body: { id: 'bot-2', enabled: true, botToken: 'token' } }),
      res
    );

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(res._body.instance.enabled, true);
    assert.equal(res._body.instance.id, 'bot-2');
  });
});

test('agent channel route updates channel instance settings through manager', async () => {
  await withOverrides([
    {
      target: agentChannelManager,
      key: 'updateChannelInstanceSettings',
      value: () => ({ id: 'default', enabled: true, botToken: 'token' })
    },
    {
      target: agentChannelManager,
      key: 'refresh',
      value: async () => [{ id: 'telegram', instanceId: 'default', status: { running: true } }]
    }
  ], async () => {
    const res = mockRes();
    await handleUpdateAgentChannelSettings(
      mockReq({ params: { channel: 'telegram', instanceId: 'default' }, body: { enabled: true, botToken: 'token' } }),
      res
    );

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(res._body.instance.enabled, true);
  });
});

test('agent channel route returns settings payload', () => {
  const res = mockRes();
  handleGetAgentChannelSettings({}, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(res._body.channels);
  assert.ok(res._body.channels.dingtalk);
});

test('agent channel route returns provider catalog metadata', () => {
  const res = mockRes();
  handleGetAgentChannelCatalog({}, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(Array.isArray(res._body.providers));
  assert.ok(res._body.providers.some((provider) => provider.id === 'telegram'));
  assert.ok(res._body.providers.some((provider) => provider.id === 'feishu'));
  assert.ok(res._body.providers.some((provider) => provider.id === 'dingtalk'));
});
