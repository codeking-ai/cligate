import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { saveAccounts as saveAntigravityAccounts } from '../../src/antigravity-account-manager.js';
import { handleListChatSources } from '../../src/routes/chat-ui-route.js';

function mockRes() {
  return {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; }
  };
}

test('handleListChatSources includes Antigravity accounts in source selector', async () => {
  saveAntigravityAccounts({
    accounts: [{
      email: 'anti@example.com',
      displayName: 'Anti User',
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3600_000,
      projectId: null,
      subscriptionType: 'free',
      models: [{ id: 'gemini-2.5-pro', publicId: 'antigravity/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }],
      addedAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      enabled: true
    }],
    activeAccount: 'anti@example.com',
    version: 1
  });

  const res = mockRes();
  await handleListChatSources({}, res);

  assert.equal(res._status, 200);
  assert.ok(Array.isArray(res._body.sources));
  const antigravity = res._body.sources.find((source) => source.id === 'antigravity:anti@example.com');
  assert.ok(antigravity);
  assert.equal(antigravity.kind, 'antigravity-account');
  assert.equal(antigravity.meta.providerType, 'gemini');
  assert.deepEqual(antigravity.meta.models, ['antigravity/gemini-2.5-pro']);
});
