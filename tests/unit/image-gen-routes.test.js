import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  handleGetImageGenStatus,
  handleAddImageGenModel,
  handleSetImageGenModelEnabled,
  handleUpdateImageGenSettings,
  handleRemoveImageGenModel
} from '../../src/routes/image-gen-route.js';
import { handleGetArtifact } from '../../src/routes/artifacts-route.js';
import { imageArtifactsDir } from '../../src/image-gen/service.js';
import artifactService from '../../src/assistant-core/artifact-service.js';
import { CONFIG_DIR } from '../../src/account-manager.js';

function mockRes() {
  const res = new PassThrough();
  res.headers = {};
  res.statusCode = 200;
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.jsonBody = o; res.end(); return res; };
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.collected = () => Buffer.concat(chunks);
  res.done = new Promise((resolve) => res.on('finish', resolve));
  return res;
}

test('image-gen management routes: add → status → toggle → settings → remove', async () => {
  const addRes = mockRes();
  handleAddImageGenModel({ body: { displayName: 'Test', backendKind: 'openai-images', apiKey: 'sk-secret-9999', nativeModel: 'gpt-image-1' } }, addRes);
  await addRes.done;
  assert.equal(addRes.statusCode, 201);
  assert.equal(addRes.jsonBody.success, true);
  assert.equal(addRes.jsonBody.model.apiKey, '••••9999');
  const id = addRes.jsonBody.model.id;

  const statusRes = mockRes();
  handleGetImageGenStatus({}, statusRes);
  await statusRes.done;
  assert.equal(statusRes.jsonBody.configured, true);
  assert.ok(statusRes.jsonBody.backendKinds.includes('openai-images'));
  assert.ok(statusRes.jsonBody.models.some((m) => m.id === id));

  const toggleRes = mockRes();
  handleSetImageGenModelEnabled({ params: { id }, body: { enabled: false } }, toggleRes);
  await toggleRes.done;
  assert.equal(toggleRes.jsonBody.model.enabled, false);

  const settingsRes = mockRes();
  handleUpdateImageGenSettings({ body: { requireApproval: false } }, settingsRes);
  await settingsRes.done;
  assert.equal(settingsRes.jsonBody.settings.requireApproval, false);

  const removeRes = mockRes();
  handleRemoveImageGenModel({ params: { id } }, removeRes);
  await removeRes.done;
  assert.equal(removeRes.jsonBody.success, true);
  assert.equal(removeRes.jsonBody.models.some((m) => m.id === id), false);
});

test('image-gen add route rejects an empty model', async () => {
  const res = mockRes();
  handleAddImageGenModel({ body: {} }, res);
  await res.done;
  assert.equal(res.statusCode, 400);
});

test('artifacts route streams a generated file with the right content-type', async () => {
  const dir = imageArtifactsDir(CONFIG_DIR);
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from('PNGBYTES-1');
  const filePath = join(dir, 'imggen-route-test.png');
  writeFileSync(filePath, bytes);
  const artifact = artifactService.createArtifact({ kind: 'image', source: 'generate_image', mediaType: 'image/png', path: filePath, imageUrl: '/api/artifacts/x' });

  const res = mockRes();
  handleGetArtifact({ params: { id: artifact.id } }, res);
  await res.done;
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.equal(res.collected().toString(), 'PNGBYTES-1');
});

test('artifacts route serves a data: URL fallback when there is no file', async () => {
  const artifact = artifactService.createArtifact({
    kind: 'image', source: 'chat_ui_upload', mediaType: 'image/png',
    imageUrl: 'data:image/png;base64,QUJD'
  });
  const res = mockRes();
  handleGetArtifact({ params: { id: artifact.id } }, res);
  await res.done;
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.equal(res.collected().toString(), 'ABC');
});

test('artifacts route 404s unknown ids and 403s paths outside the config dir', async () => {
  const missing = mockRes();
  handleGetArtifact({ params: { id: 'nope' } }, missing);
  await missing.done;
  assert.equal(missing.statusCode, 404);

  const evil = artifactService.createArtifact({ kind: 'image', source: 'x', mediaType: 'image/png', path: process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd' });
  const blocked = mockRes();
  handleGetArtifact({ params: { id: evil.id } }, blocked);
  await blocked.done;
  assert.equal(blocked.statusCode, 403);
});
