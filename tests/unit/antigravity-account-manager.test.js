import test from 'node:test';
import assert from 'node:assert/strict';

import { accountSupportsAntigravityModel } from '../../src/antigravity-account-manager.js';

test('accountSupportsAntigravityModel matches mapped Antigravity model ids', () => {
  const account = {
    models: [
      { id: 'claude-opus-4-6-thinking' }
    ]
  };

  assert.equal(accountSupportsAntigravityModel(account, 'antigravity/claude-opus-4-6'), true);
  assert.equal(accountSupportsAntigravityModel(account, 'antigravity/claude-haiku-4-5-20251001'), false);
});
