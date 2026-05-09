import '../test-env.js';
/**
 * Unit tests for src/model-mapper.js
 * Tests model name mapping, kilo detection, and routing resolution.
 * No server required — logic tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapClaudeModel,
  isKiloModel,
  resolveKiloModel,
  resolveModelRouting
} from '../../src/model-mapper.js';
import modelMapperDefault from '../../src/model-mapper.js';
const { CLAUDE_MODEL_MAP } = modelMapperDefault;

// ─── mapClaudeModel ───────────────────────────────────────────────────────────

test('mapClaudeModel: maps claude-opus-4-5 to gpt-5.3-codex', () => {
  assert.equal(mapClaudeModel('claude-opus-4-5'), 'gpt-5.3-codex');
});

test('mapClaudeModel: maps claude-sonnet-4-5 to gpt-5.2', () => {
  assert.equal(mapClaudeModel('claude-sonnet-4-5'), 'gpt-5.2');
});

test('mapClaudeModel: maps claude-haiku-4-20250514 to kilo', () => {
  assert.equal(mapClaudeModel('claude-haiku-4-20250514'), 'kilo');
});

test('mapClaudeModel: maps claude-3-haiku-20240307 to kilo', () => {
  assert.equal(mapClaudeModel('claude-3-haiku-20240307'), 'kilo');
});

test('mapClaudeModel: maps claude-3-opus-20240229 to gpt-5.3-codex', () => {
  assert.equal(mapClaudeModel('claude-3-opus-20240229'), 'gpt-5.3-codex');
});

test('mapClaudeModel: maps shorthand "haiku" to kilo', () => {
  assert.equal(mapClaudeModel('haiku'), 'kilo');
});

test('mapClaudeModel: maps shorthand "opus" to gpt-5.3-codex', () => {
  assert.equal(mapClaudeModel('opus'), 'gpt-5.3-codex');
});

test('mapClaudeModel: maps shorthand "sonnet" to gpt-5.2', () => {
  assert.equal(mapClaudeModel('sonnet'), 'gpt-5.2');
});

test('mapClaudeModel: passes through gpt-5.3-codex unchanged', () => {
  assert.equal(mapClaudeModel('gpt-5.3-codex'), 'gpt-5.3-codex');
});

test('mapClaudeModel: passes through gpt-5.2 unchanged', () => {
  assert.equal(mapClaudeModel('gpt-5.2'), 'gpt-5.2');
});

test('mapClaudeModel: falls back to gpt-5.2 for unknown model', () => {
  assert.equal(mapClaudeModel('unknown-model-xyz'), 'gpt-5.2');
});

test('mapClaudeModel: falls back to gpt-5.2 for null/undefined', () => {
  assert.equal(mapClaudeModel(null), 'gpt-5.2');
  assert.equal(mapClaudeModel(undefined), 'gpt-5.2');
  assert.equal(mapClaudeModel(''), 'gpt-5.2');
});

test('mapClaudeModel: fuzzy match claude-*-opus-* to gpt-5.3-codex', () => {
  assert.equal(mapClaudeModel('claude-3-5-opus-20250514'), 'gpt-5.3-codex');
});

test('mapClaudeModel: fuzzy match claude-*-haiku-* to kilo', () => {
  assert.equal(mapClaudeModel('claude-3-5-haiku-20250514'), 'kilo');
});

test('mapClaudeModel: fuzzy match claude-*-sonnet-* to gpt-5.2', () => {
  assert.equal(mapClaudeModel('claude-3-5-sonnet-20250514'), 'gpt-5.2');
});

// ─── isKiloModel ─────────────────────────────────────────────────────────────

test('isKiloModel: returns true for "kilo"', () => {
  assert.equal(isKiloModel('kilo'), true);
});

test('isKiloModel: returns false for non-kilo models', () => {
  assert.equal(isKiloModel('gpt-5.2'), false);
  assert.equal(isKiloModel('gpt-5.3-codex'), false);
  assert.equal(isKiloModel(''), false);
  assert.equal(isKiloModel(null), false);
});

// ─── resolveKiloModel ────────────────────────────────────────────────────────

test('resolveKiloModel: returns a non-empty string', () => {
  const result = resolveKiloModel();
  assert.ok(typeof result === 'string' && result.length > 0);
});

test('resolveKiloModel: returns one of the known kilo model identifiers', () => {
  const result = resolveKiloModel();
  // Model is now stored as full ID (e.g. 'minimax/minimax-m2.5:free')
  assert.ok(typeof result === 'string' && result.length > 0, `Unexpected kilo model: ${result}`);
});

// ─── resolveModelRouting ─────────────────────────────────────────────────────

test('resolveModelRouting: haiku model routes to kilo', () => {
  const result = resolveModelRouting('claude-haiku-4');
  assert.equal(result.isKilo, true);
  assert.ok(result.kiloTarget !== null);
  assert.equal(result.upstreamModel, result.kiloTarget);
});

test('resolveModelRouting: opus model does NOT route to kilo', () => {
  const result = resolveModelRouting('claude-opus-4-5');
  assert.equal(result.isKilo, false);
  assert.equal(result.kiloTarget, null);
  assert.equal(result.mappedModel, 'gpt-5.3-codex');
  assert.equal(result.upstreamModel, 'gpt-5.3-codex');
});

test('resolveModelRouting: sonnet model does NOT route to kilo', () => {
  const result = resolveModelRouting('claude-sonnet-4-5');
  assert.equal(result.isKilo, false);
  assert.equal(result.kiloTarget, null);
  assert.equal(result.mappedModel, 'gpt-5.2');
});

test('resolveModelRouting: unknown model falls back to gpt-5.2 (non-kilo)', () => {
  const result = resolveModelRouting('totally-unknown-model');
  assert.equal(result.isKilo, false);
  assert.equal(result.mappedModel, 'gpt-5.2');
});

test('resolveModelRouting: null/undefined defaults to gpt-5.2 (non-kilo)', () => {
  const result = resolveModelRouting(null);
  assert.equal(result.isKilo, false);
  assert.equal(result.mappedModel, 'gpt-5.2');
});

test('resolveModelRouting: returns all four expected keys', () => {
  const result = resolveModelRouting('claude-haiku-4');
  assert.ok('mappedModel' in result);
  assert.ok('isKilo' in result);
  assert.ok('kiloTarget' in result);
  assert.ok('upstreamModel' in result);
});

// ─── CLAUDE_MODEL_MAP sanity checks ──────────────────────────────────────────

test('CLAUDE_MODEL_MAP: is a non-empty object', () => {
  assert.ok(typeof CLAUDE_MODEL_MAP === 'object' && CLAUDE_MODEL_MAP !== null);
  assert.ok(Object.keys(CLAUDE_MODEL_MAP).length > 0);
});

test('CLAUDE_MODEL_MAP: all values are non-empty strings', () => {
  for (const [key, value] of Object.entries(CLAUDE_MODEL_MAP)) {
    assert.ok(typeof value === 'string' && value.length > 0, `Value for "${key}" is invalid: ${value}`);
  }
});
