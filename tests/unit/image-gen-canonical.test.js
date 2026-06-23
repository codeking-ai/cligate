import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCanonicalInput,
  aspectRatioToDimensions,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_QUALITY
} from '../../src/image-gen/canonical.js';

test('normalizeCanonicalInput requires a prompt', () => {
  assert.throws(() => normalizeCanonicalInput({ prompt: '   ' }), /requires a non-empty/);
  assert.throws(() => normalizeCanonicalInput({}), /requires a non-empty/);
});

test('normalizeCanonicalInput applies defaults', () => {
  const { canonical, notes } = normalizeCanonicalInput({ prompt: 'a cat' });
  assert.equal(canonical.prompt, 'a cat');
  assert.equal(canonical.aspectRatio, DEFAULT_ASPECT_RATIO);
  assert.equal(canonical.quality, DEFAULT_QUALITY);
  assert.equal(canonical.n, 1);
  assert.equal(canonical.seed, null);
  assert.deepEqual(notes, []);
});

test('normalizeCanonicalInput coerces invalid enums with honest notes', () => {
  const { canonical, notes } = normalizeCanonicalInput({
    prompt: 'x',
    aspectRatio: '21:9',
    quality: 'ultra'
  });
  assert.equal(canonical.aspectRatio, DEFAULT_ASPECT_RATIO);
  assert.equal(canonical.quality, DEFAULT_QUALITY);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /aspectRatio/);
  assert.match(notes[1], /quality/);
});

test('normalizeCanonicalInput clamps n to maxImagesPerCall', () => {
  const { canonical, notes } = normalizeCanonicalInput({ prompt: 'x', n: 9 }, { maxImagesPerCall: 2 });
  assert.equal(canonical.n, 2);
  assert.ok(notes.some((note) => /clamped to 2/.test(note)));
});

test('normalizeCanonicalInput keeps providerParams as an object only', () => {
  const ok = normalizeCanonicalInput({ prompt: 'x', providerParams: { steps: 30 } });
  assert.deepEqual(ok.canonical.providerParams, { steps: 30 });
  const bad = normalizeCanonicalInput({ prompt: 'x', providerParams: [1, 2] });
  assert.deepEqual(bad.canonical.providerParams, {});
});

test('aspectRatioToDimensions yields 64-aligned dimensions per orientation', () => {
  assert.deepEqual(aspectRatioToDimensions('1:1', 1024), { width: 1024, height: 1024 });
  assert.deepEqual(aspectRatioToDimensions('16:9', 1024), { width: 1024, height: 576 });
  assert.deepEqual(aspectRatioToDimensions('9:16', 1024), { width: 576, height: 1024 });
  // unknown ratio falls back to square
  assert.deepEqual(aspectRatioToDimensions('weird', 1024), { width: 1024, height: 1024 });
});
