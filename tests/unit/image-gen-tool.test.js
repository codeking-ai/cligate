import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import createImageGenToolHandlers from '../../src/assistant-tools/handlers/image-gen.js';
import createGenerateImageToolDefinition from '../../src/assistant-tools/definitions/generate-image.js';
import { ImageGenError } from '../../src/image-gen/service.js';

function fakeServiceOk() {
  return {
    async generate() {
      return {
        model: 'gpt-image-1',
        modelName: 'OpenAI',
        aspectRatio: '1:1',
        quality: 'standard',
        count: 1,
        cost: 0.04,
        notes: ['n is fine'],
        images: [{ base64: 'QUJD', mediaType: 'image/png' }],
        artifacts: [{ artifactId: 'art-1', path: '/tmp/x.png', downloadUrl: '/api/artifacts/art-1', mediaType: 'image/png' }]
      };
    }
  };
}

test('generateImage returns canonical image content blocks + artifact metadata', async () => {
  const { generateImage } = createImageGenToolHandlers({ service: fakeServiceOk() });
  const out = await generateImage({ input: { prompt: 'a cat' }, context: { conversation: { id: 'c1' } } });

  assert.equal(out.kind, 'image_generation_result');
  assert.equal(out.artifactId, 'art-1');
  assert.equal(out.cost, 0.04);
  assert.deepEqual(out.notes, ['n is fine']);
  assert.equal(out.content.length, 1);
  assert.equal(out.content[0].type, 'image');
  assert.equal(out.content[0].source.type, 'base64');
  assert.equal(out.content[0].source.media_type, 'image/png');
  assert.equal(out.content[0].source.data, 'QUJD');
  // base64 must NOT leak into the structured metadata (only into content blocks)
  assert.equal(out.artifacts[0].artifactId, 'art-1');
  assert.equal(JSON.stringify(out.artifacts).includes('QUJD'), false);
});

test('generateImage maps ImageGenError to a recoverable failure result (no throw)', async () => {
  const service = { async generate() { throw new ImageGenError('no image model is configured', { code: 'NO_MODEL' }); } };
  const { generateImage } = createImageGenToolHandlers({ service });
  const out = await generateImage({ input: { prompt: 'x' }, context: {} });
  assert.equal(out.kind, 'image_generation_failed');
  assert.equal(out.code, 'NO_MODEL');
  assert.equal(out.recoverable, true);
  assert.match(out.error, /no image model/);
});

test('generateImage rethrows unexpected (non-ImageGen) errors', async () => {
  const service = { async generate() { throw new TypeError('boom'); } };
  const { generateImage } = createImageGenToolHandlers({ service });
  await assert.rejects(generateImage({ input: { prompt: 'x' }, context: {} }), /boom/);
});

test('definition requiresApproval follows the image-gen setting', () => {
  const gated = createGenerateImageToolDefinition({ handlers: {}, store: { getSettings: () => ({ requireApproval: true }) } });
  assert.equal(gated.requiresApproval, true);
  assert.equal(gated.mutating, false);
  assert.equal(gated.name, 'generate_image');

  const open = createGenerateImageToolDefinition({ handlers: {}, store: { getSettings: () => ({ requireApproval: false }) } });
  assert.equal(open.requiresApproval, false);

  // store failure → safe default (gated)
  const broken = createGenerateImageToolDefinition({ handlers: {}, store: { getSettings: () => { throw new Error('x'); } } });
  assert.equal(broken.requiresApproval, true);
});
