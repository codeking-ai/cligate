import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ImageGenService, ImageGenError } from '../../src/image-gen/service.js';
import { ImageGenModelStore } from '../../src/image-gen/model-store.js';
import { registerBackend, ImageBackendError, IMAGE_ERROR } from '../../src/image-gen/backend.js';
import { getCredentialRuntimeState } from '../../src/runtime-state.js';
import { ArtifactStore } from '../../src/assistant-core/domain/artifact-store.js';
import { TaskStore } from '../../src/assistant-core/domain/task-store.js';
import { ArtifactService } from '../../src/assistant-core/artifact-service.js';

const FAKE_PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

// A controllable fake backend so the service test never touches the network.
let fakeBehavior = { mode: 'ok', notes: [] };
registerBackend({
  kind: 'fake-img-test',
  capabilities: () => ({ negativePrompt: true, seed: true, maxN: 4 }),
  mapParams: (canonical) => ({ native: { model: 'fake-model', prompt: canonical.prompt }, notes: fakeBehavior.notes || [] }),
  generate: async () => {
    if (fakeBehavior.mode === 'auth') throw new ImageBackendError('bad key', { code: IMAGE_ERROR.AUTH, status: 401 });
    if (fakeBehavior.mode === 'rate') throw new ImageBackendError('slow', { code: IMAGE_ERROR.RATE_LIMITED, retryAfterMs: 60000 });
    return { images: [{ base64: FAKE_PNG_B64, mediaType: 'image/png' }], model: 'fake-model', usage: null };
  }
});

function buildService() {
  const configDir = mkdtempSync(join(tmpdir(), 'cligate-imggen-svc-'));
  const store = new ImageGenModelStore({ configDir });
  const artifacts = new ArtifactService({
    artifactStore: new ArtifactStore({ configDir }),
    taskStore: new TaskStore({ configDir })
  });
  const service = new ImageGenService({ store, artifacts, configDir });
  return { service, store, configDir };
}

test('generate throws NO_MODEL when nothing is configured', async () => {
  const { service } = buildService();
  await assert.rejects(service.generate({ prompt: 'cat' }), (err) => {
    assert.ok(err instanceof ImageGenError);
    assert.equal(err.code, 'NO_MODEL');
    return true;
  });
});

test('generate writes a file, creates an image artifact, returns base64 + accumulates cost', async () => {
  fakeBehavior = { mode: 'ok', notes: [] };
  const { service, store } = buildService();
  const model = store.addModel({ displayName: 'Fake', backendKind: 'fake-img-test', apiKey: 'k', pricing: { perImage: 0.05 } });

  const result = await service.generate({ prompt: 'a cat', aspectRatio: '16:9' }, { conversationId: 'conv-1' });

  assert.equal(result.count, 1);
  assert.equal(result.images[0].base64, FAKE_PNG_B64);
  assert.equal(result.images[0].mediaType, 'image/png');
  assert.equal(result.artifacts.length, 1);
  assert.ok(result.artifacts[0].artifactId);
  assert.match(result.artifacts[0].downloadUrl, /^\/api\/artifacts\//);
  assert.ok(existsSync(result.artifacts[0].path), 'image file written to disk');
  assert.equal(readFileSync(result.artifacts[0].path).toString('base64'), FAKE_PNG_B64);
  assert.equal(result.cost, 0.05);

  const after = store.getModel(model.id);
  assert.equal(after.totalImages, 1);
  assert.equal(after.totalRequests, 1);
  assert.equal(after.totalCost, 0.05);
});

test('generate surfaces canonical + backend degrade notes honestly', async () => {
  fakeBehavior = { mode: 'ok', notes: ['model ignored seed'] };
  const { service, store } = buildService();
  store.addModel({ displayName: 'Fake', backendKind: 'fake-img-test', apiKey: 'k' });

  const result = await service.generate({ prompt: 'x', aspectRatio: 'bogus' });
  assert.ok(result.notes.some((n) => /aspectRatio/.test(n)), 'canonical coercion note present');
  assert.ok(result.notes.some((n) => /ignored seed/.test(n)), 'backend degrade note present');
});

test('an AUTH failure marks the credential invalid and increments the error count', async () => {
  fakeBehavior = { mode: 'auth', notes: [] };
  const { service, store } = buildService();
  const model = store.addModel({ displayName: 'Fake', backendKind: 'fake-img-test', apiKey: 'k' });

  await assert.rejects(service.generate({ prompt: 'x' }), (err) => err.code === IMAGE_ERROR.AUTH || err instanceof ImageGenError);
  assert.equal(store.getModel(model.id).errors, 1);
  assert.equal(getCredentialRuntimeState(model.id).status, 'invalid');
});

test('a disabled model is rejected', async () => {
  fakeBehavior = { mode: 'ok', notes: [] };
  const { service, store } = buildService();
  const model = store.addModel({ displayName: 'Fake', backendKind: 'fake-img-test', apiKey: 'k', enabled: false });
  await assert.rejects(service.generate({ prompt: 'x', model: model.id }), (err) => err.code === 'MODEL_DISABLED');
});
