import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createChannelsPageModule } from '../../public/js/modules/channels-page.js';

function createHarness(overrides = {}) {
  const app = createChannelsPageModule();
  Object.assign(app, {
    lang: 'zh',
    agentRuntimeProviders: [{ id: 'codex' }],
    channelCatalog: [],
    channelProviders: [],
    channelConversations: [],
    channelSettings: {},
    t(key, ...args) {
      const table = {
        channelName_weixin: '微信',
        channelName_feishu: '飞书',
        channelName_dingtalk: '钉钉',
        channelSectionBasic: '基础',
        channelSectionAuth: '鉴权',
        channelSectionTransport: '传输',
        channelSectionRuntime: '运行时',
        channelSectionSecurity: '安全',
        channelSectionAdvanced: '高级',
        channelInstanceDefault: '默认实例',
        channelInstanceNumbered: (count) => `实例 ${count}`
      };
      const value = table[key];
      if (typeof value === 'function') return value(...args);
      return value ?? key;
    },
    chatRuntimeProviderLabel(id) {
      return id;
    },
    showToast() {}
  });
  Object.assign(app, overrides);
  return app;
}

test('channels page localizes channel labels in filter options', () => {
  const app = createHarness({
    channelCatalog: [{ id: 'weixin', label: 'WeChat' }],
    channelProviders: [{ id: 'feishu', label: 'Feishu' }],
    channelConversations: [{ id: 'conv-1', channel: 'dingtalk' }]
  });

  assert.deepEqual(app.channelConversationFilterOptions, [
    { id: 'weixin', label: '微信' },
    { id: 'feishu', label: '飞书' },
    { id: 'dingtalk', label: '钉钉' }
  ]);
});

test('channels page localizes section labels and default instance labels', () => {
  const app = createHarness();

  assert.equal(app.channelSectionLabel('basic'), '基础');
  assert.equal(app.channelSectionLabel('runtime'), '运行时');
  assert.equal(app.channelSectionLabel('advanced'), '高级');
  assert.equal(app.defaultChannelFieldValue({ key: 'label' }), '默认实例');
  assert.equal(app.buildDefaultChannelInstance({ configFields: [] }).label, '默认实例');
  assert.equal(app.channelInstanceLabel({ label: 'Default' }), '默认实例');
  assert.equal(app.channelInstanceLabel({ label: '' }), '默认实例');
});

test('channels page numbers new instances with translated label', async () => {
  const app = createHarness({
    channelCatalog: [{ id: 'weixin', configFields: [] }],
    channelSettings: {
      weixin: {
        instances: [{ id: 'default', label: '默认实例' }]
      }
    },
    async api() {
      return {
        ok: true,
        data: {
          instance: { id: 'weixin-2', label: '实例 2', enabled: false }
        }
      };
    },
    async loadChannelProviders() {}
  });

  await app.addChannelInstance({ id: 'weixin', configFields: [] });

  assert.equal(app.channelSettings.weixin.instances[1].label, '实例 2');
});
