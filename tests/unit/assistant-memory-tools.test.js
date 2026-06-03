import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import createDefaultAssistantToolRegistry from '../../src/assistant-core/tool-registry.js';

// Validates that remember / recall_memory / search_memory are wired into the
// supervisor tool registry and round-trip through the (sandboxed) memory store.
const registry = createDefaultAssistantToolRegistry();

test('memory tools are registered on the supervisor tool registry', () => {
  assert.ok(registry.get('remember'), 'remember tool missing');
  assert.ok(registry.get('recall_memory'), 'recall_memory tool missing');
  assert.ok(registry.get('search_memory'), 'search_memory tool missing');
});

test('remember -> recall_memory -> search_memory round-trips', async () => {
  const saved = await registry.get('remember').execute({
    input: {
      title: 'wiring-test-publish-zzz',
      kind: 'procedure',
      topic: 'example.test',
      keywords: ['wiringtestpublish', 'zzz-flow'],
      body: '1. step one\n2. step two'
    },
    context: {}
  });
  assert.equal(saved.ok, true);
  assert.ok(saved.id);

  const recalled = await registry.get('recall_memory').execute({ input: { id: saved.id } });
  assert.equal(recalled.ok, true);
  assert.equal(recalled.body, '1. step one\n2. step two');
  assert.ok(recalled.freshnessNote, 'procedure recall should carry a freshness note');

  const found = await registry.get('search_memory').execute({ input: { query: 'wiringtestpublish' } });
  assert.ok(found.count >= 1);
  assert.ok(found.matches.some((m) => m.id === saved.id));
});

test('recall_memory on a missing id returns MEMORY_NOT_FOUND (not a throw)', async () => {
  const res = await registry.get('recall_memory').execute({ input: { id: 'definitely-not-a-real-memory-id' } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'MEMORY_NOT_FOUND');
});

test('remember with an empty title fails gracefully (recoverable, no throw)', async () => {
  const res = await registry.get('remember').execute({ input: { body: 'no title' }, context: {} });
  assert.equal(res.ok, false);
  assert.equal(res.recoverable, true);
});

// --- Phase C: skill authoring tools ----------------------------------------

test('save_skill and promote_memory_to_skill are registered', () => {
  assert.ok(registry.get('save_skill'), 'save_skill tool missing');
  assert.ok(registry.get('promote_memory_to_skill'), 'promote_memory_to_skill tool missing');
});

test('save_skill writes a skill (the shared low-level writer)', async () => {
  const res = await registry.get('save_skill').execute({
    input: {
      name: 'wiring-skill-zzz',
      description: 'A wiring-test skill. Use when the user mentions wiringskillzzz.',
      body: '# wiring\n1. do a thing\n2. do another'
    }
  });
  assert.equal(res.ok, true);
  assert.ok(res.path.includes('wiring-skill-zzz'));
});

test('promote_memory_to_skill crystallizes an existing memory into a skill', async () => {
  const mem = await registry.get('remember').execute({
    input: { title: 'promote-wiring-zzz', kind: 'procedure', keywords: ['promwirezzz'], body: '1. step a\n2. step b' },
    context: {}
  });
  assert.equal(mem.ok, true);
  const promoted = await registry.get('promote_memory_to_skill').execute({ input: { memoryId: mem.id } });
  assert.equal(promoted.ok, true);
  assert.equal(promoted.fromMemoryId, mem.id);
});

test('promote_memory_to_skill on a missing memory returns MEMORY_NOT_FOUND', async () => {
  const res = await registry.get('promote_memory_to_skill').execute({ input: { memoryId: 'no-such-memory-zzz' } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'MEMORY_NOT_FOUND');
});
