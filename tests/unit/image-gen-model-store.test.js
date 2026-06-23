import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ImageGenModelStore, DEFAULT_SETTINGS } from '../../src/image-gen/model-store.js';

function freshStore() {
  const configDir = mkdtempSync(join(tmpdir(), 'cligate-imggen-store-'));
  return new ImageGenModelStore({ configDir });
}

test('addModel persists and listModels masks the apiKey', () => {
  const store = freshStore();
  const safe = store.addModel({ displayName: 'OpenAI', backendKind: 'openai-images', apiKey: 'sk-secret-1234', nativeModel: 'gpt-image-1' });
  assert.ok(safe.id.startsWith('img_'));
  assert.equal(safe.apiKey, '••••1234');
  assert.equal(safe.hasApiKey, true);

  const listed = store.listModels();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].apiKey, '••••1234');

  const withSecret = store.getModel(safe.id, { includeSecrets: true });
  assert.equal(withSecret.apiKey, 'sk-secret-1234');
});

test('updateModel preserves the secret when given a masked/empty value but replaces a real one', () => {
  const store = freshStore();
  const safe = store.addModel({ apiKey: 'sk-original', nativeModel: 'gpt-image-1' });

  store.updateModel(safe.id, { apiKey: '••••inal', displayName: 'Renamed' });
  assert.equal(store.getModel(safe.id, { includeSecrets: true }).apiKey, 'sk-original');
  assert.equal(store.getModel(safe.id).displayName, 'Renamed');

  store.updateModel(safe.id, { apiKey: '' });
  assert.equal(store.getModel(safe.id, { includeSecrets: true }).apiKey, 'sk-original');

  store.updateModel(safe.id, { apiKey: 'sk-rotated' });
  assert.equal(store.getModel(safe.id, { includeSecrets: true }).apiKey, 'sk-rotated');
});

test('settings default and round-trip', () => {
  const store = freshStore();
  assert.deepEqual(store.getSettings(), { ...DEFAULT_SETTINGS });
  const next = store.setSettings({ requireApproval: false, maxImagesPerCall: 9 });
  assert.equal(next.requireApproval, false);
  assert.equal(next.maxImagesPerCall, 4, 'maxImagesPerCall is hard-capped at 4');
  assert.equal(store.getSettings().requireApproval, false);
});

test('resolveModel prefers explicit id, then default, then first enabled', () => {
  const store = freshStore();
  const a = store.addModel({ displayName: 'A', apiKey: 'k', enabled: false });
  const b = store.addModel({ displayName: 'B', apiKey: 'k' });
  const c = store.addModel({ displayName: 'C', apiKey: 'k' });

  // explicit
  assert.equal(store.resolveModel(b.id).id, b.id);
  // default wins over first-enabled
  store.setSettings({ defaultModelId: c.id });
  assert.equal(store.resolveModel('').id, c.id);
  // disabled default falls through to first enabled (skips A which is disabled)
  store.setSettings({ defaultModelId: a.id });
  const resolved = store.resolveModel('');
  assert.notEqual(resolved.id, a.id);
  assert.ok([b.id, c.id].includes(resolved.id));
});

test('removeModel clears it as the default and recordModelUsage accumulates', () => {
  const store = freshStore();
  const m = store.addModel({ displayName: 'M', apiKey: 'k' });
  store.setSettings({ defaultModelId: m.id });

  store.recordModelUsage(m.id, { images: 2, cost: 0.08 });
  store.recordModelUsage(m.id, { images: 1, cost: 0.04 });
  const after = store.getModel(m.id);
  assert.equal(after.totalRequests, 2);
  assert.equal(after.totalImages, 3);
  assert.equal(after.totalCost, 0.12);

  store.removeModel(m.id);
  assert.equal(store.getModel(m.id), null);
  assert.equal(store.getSettings().defaultModelId, '');
});
