import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import assistantPolicyService from '../../src/assistant-core/policy-service.js';
import { redactSecrets } from '../../src/utils/redact-secrets.js';
import { AssistantMemoryStore } from '../../src/agent-core/memory/memory-store.js';
import { buildMemoryRecallContext, memoryAppliesToScope } from '../../src/agent-core/memory/index.js';
import createDefaultAssistantToolRegistry from '../../src/assistant-core/tool-registry.js';

function freshStore() {
  return new AssistantMemoryStore({ dir: mkdtempSync(join(tmpdir(), 'cligate-review-')) });
}

// --- Issue 1: the memory/skill tools must pass the supervisor policy gate ----
// (Direct registry.execute() in earlier tests bypassed policy; this checks the
// real gate that AssistantToolExecutor applies before every tool call.)

test('policy ALLOWS all memory/skill tools (otherwise they default-deny in real ReAct)', () => {
  for (const toolName of ['remember', 'recall_memory', 'search_memory', 'save_skill', 'promote_memory_to_skill']) {
    const decision = assistantPolicyService.canExecuteToolCall({ toolName });
    assert.equal(decision.allowed, true, `${toolName} must be permitted by policy`);
    assert.notEqual(decision.requiresConfirmation, true, `${toolName} should not require a confirmation prompt`);
  }
});

test('policy still default-denies an unknown tool (the gate is real)', () => {
  assert.equal(assistantPolicyService.canExecuteToolCall({ toolName: 'definitely_not_a_tool' }).allowed, false);
});

// --- Issue 3: deterministic secret redaction -------------------------------

test('redactSecrets scrubs known token shapes and labeled secrets, leaves prose alone', () => {
  assert.match(redactSecrets('api_key: sk-abcdef0123456789ABCDEF'), /\[redacted\]/);
  assert.doesNotMatch(redactSecrets('api_key: sk-abcdef0123456789ABCDEF'), /sk-abcdef/);
  assert.match(redactSecrets('Authorization: Bearer abcdefghijklmnop12345'), /\[redacted\]/);
  assert.match(redactSecrets('密码：Sap12345!'), /\[redacted\]/);
  assert.doesNotMatch(redactSecrets('密码：Sap12345!'), /Sap12345/);
  // ordinary procedure prose is untouched
  assert.equal(redactSecrets('open the browser and click login'), 'open the browser and click login');
  assert.equal(redactSecrets('test = https://test.foo.com'), 'test = https://test.foo.com');
});

test('memory store redacts secrets before writing to disk', () => {
  const store = freshStore();
  const saved = store.upsert({ title: 'login flow', kind: 'procedure', body: 'enter creds; api_key: sk-SECRET0123456789abcd then submit' });
  assert.doesNotMatch(saved.body, /sk-SECRET/);
  // and on disk
  const onDisk = readFileSync(join(store.dir, `${saved.id}.md`), 'utf8');
  assert.doesNotMatch(onDisk, /sk-SECRET/);
  assert.match(onDisk, /\[redacted\]/);
});

// --- Issue 4: scope-aware recall (no cross-project leakage) -----------------

test('memoryAppliesToScope: global/person everywhere, project only in-tree', () => {
  assert.equal(memoryAppliesToScope('global', '/any/where'), true);
  assert.equal(memoryAppliesToScope('person', ''), true);
  assert.equal(memoryAppliesToScope('project:/d/projA', '/d/projA'), true);
  assert.equal(memoryAppliesToScope('project:/d/projA', '/d/projA/sub'), true);
  assert.equal(memoryAppliesToScope('project:/d/projA', '/d/projB'), false);
  assert.equal(memoryAppliesToScope('project:/d/projA', ''), false); // no cwd → don't leak
});

test('buildMemoryRecallContext filters project-scoped standing memory by cwd', () => {
  const store = freshStore();
  store.upsert({ title: 'always-global', kind: 'directive', recall: 'always', scope: 'global', body: 'g' });
  store.upsert({ title: 'always-projA', kind: 'directive', recall: 'always', scope: 'project:/d/projA', body: 'a' });

  const inA = buildMemoryRecallContext('', { cwd: '/d/projA', store });
  assert.deepEqual(inA.standingMemory.map((m) => m.title).sort(), ['always-global', 'always-projA'].sort());

  const inB = buildMemoryRecallContext('', { cwd: '/d/projB', store });
  assert.deepEqual(inB.standingMemory.map((m) => m.title), ['always-global']); // projA hidden in projB
});

// --- Issue 7: recall_memory usedCount must not double-count -----------------

test('recall_memory reports usedCount matching disk (no off-by-one)', async () => {
  const registry = createDefaultAssistantToolRegistry();
  const mem = await registry.get('remember').execute({
    input: { title: 'offbyone-check-zzz', kind: 'fact', keywords: ['offbyonezzz'], body: 'the fact' },
    context: {}
  });
  const first = await registry.get('recall_memory').execute({ input: { id: mem.id } });
  assert.equal(first.usedCount, 1, 'first recall should report exactly 1');
  const second = await registry.get('recall_memory').execute({ input: { id: mem.id } });
  assert.equal(second.usedCount, 2, 'second recall should report exactly 2');
});

// --- Issue 8: memory-store.js must be plain text (no control bytes) ---------

test('memory-store.js contains no NUL/control bytes (git treats it as text)', () => {
  const buf = readFileSync(new URL('../../src/agent-core/memory/memory-store.js', import.meta.url));
  let control = 0;
  for (const b of buf) {
    if (b === 0 || b < 9 || (b > 13 && b < 32)) control += 1;
  }
  assert.equal(control, 0);
});
