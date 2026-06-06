import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AssistantRunStore } from '../../src/assistant-core/run-store.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'cligate-run-compaction-'));
}

const DAY = 24 * 60 * 60 * 1000;

// Build a run with heavy toolResults + checkpoint payloads, like a real
// desktop-automation / publish run that bloats assistant-runs.json.
function heavyRun({ id, status, ageDays, resumable = false }) {
  const createdAt = new Date(Date.now() - ageDays * DAY).toISOString();
  const heavyToolResults = [
    {
      toolName: 'run_shell_command',
      status: 'completed',
      summary: 'ran wechatsync',
      input: { command: 'x'.repeat(5000) },
      result: { stdout: 'y'.repeat(20000) },
      structured: { blob: 'z'.repeat(20000) },
      metadata: { artifactId: `artifact-${id}` }
    }
  ];
  return {
    id,
    assistantSessionId: 'sess-1',
    conversationId: 'conv-1',
    triggerText: 'do the thing',
    mode: 'session',
    status,
    summary: 'done',
    result: 'ok',
    steps: [{ kind: 'tool', toolName: 'run_shell_command', status: 'completed', summary: 's' }],
    relatedRuntimeSessionIds: [],
    metadata: {
      toolResults: heavyToolResults,
      checkpoint: {
        resumable,
        completedStepCount: 3,
        pendingStepCount: 0,
        lastCompletedStep: { big: 'q'.repeat(10000) },
        plan: { steps: Array.from({ length: 50 }, (_, i) => ({ i, note: 'p'.repeat(500) })) },
        toolResults: heavyToolResults,
        skills: { active: ['x'], history: ['p'.repeat(2000)] },
        updatedAt: createdAt
      }
    },
    createdAt,
    updatedAt: createdAt
  };
}

test('compactRuns archives + slims old terminal non-resumable runs, preserves the rest', () => {
  const configDir = tempDir();
  const store = new AssistantRunStore({ configDir });

  store.save(heavyRun({ id: 'old-completed', status: 'completed', ageDays: 10 }));
  store.save(heavyRun({ id: 'old-failed-resumable', status: 'failed', ageDays: 10, resumable: true }));
  store.save(heavyRun({ id: 'old-failed-nonresumable', status: 'failed', ageDays: 10, resumable: false }));
  store.save(heavyRun({ id: 'recent-completed', status: 'completed', ageDays: 0.04 })); // ~1h old
  store.save(heavyRun({ id: 'running', status: 'running', ageDays: 10 }));

  const sizeBefore = jsonLen(store.get('old-completed'));
  const { compacted, reclaimedBytes } = store.compactRuns();

  // old completed + old failed-nonresumable are eligible; resumable/recent/running are not.
  assert.equal(compacted, 2, 'exactly the two old non-resumable terminal runs compact');
  assert.ok(reclaimedBytes > 40000, 'reclaimed meaningful bytes');

  // --- old completed: slimmed in the hot store ---
  const slimmed = store.get('old-completed');
  assert.equal(slimmed.metadata.compacted, true);
  assert.equal(slimmed.metadata.toolResults.length, 1);
  assert.equal(slimmed.metadata.toolResults[0].metadata.artifactId, 'artifact-old-completed', 'artifactId preserved for channel router');
  assert.equal(slimmed.metadata.toolResults[0].input, undefined, 'heavy input dropped');
  assert.equal(slimmed.metadata.toolResults[0].result, undefined, 'heavy result dropped');
  assert.equal(slimmed.metadata.toolResults[0].summary, 'ran wechatsync', 'summary kept');
  // checkpoint collapsed to the light fields task-view reads
  assert.equal(slimmed.metadata.checkpoint.resumable, false);
  assert.equal(slimmed.metadata.checkpoint.completedStepCount, 3);
  assert.equal(slimmed.metadata.checkpoint.pendingStepCount, 0);
  assert.equal(slimmed.metadata.checkpoint.toolResults, undefined, 'heavy checkpoint.toolResults dropped');
  assert.equal(slimmed.metadata.checkpoint.plan, undefined, 'heavy checkpoint.plan dropped');
  assert.ok(jsonLen(slimmed) < sizeBefore / 5, 'slimmed record is much smaller');
  // top-level light fields intact
  assert.equal(slimmed.status, 'completed');
  assert.equal(slimmed.summary, 'done');
  assert.equal(slimmed.steps.length, 1);

  // --- failed + resumable: fully preserved (resume needs it) ---
  const resumable = store.get('old-failed-resumable');
  assert.equal(resumable.metadata.compacted, undefined, 'resumable run not marked compacted');
  assert.equal(resumable.metadata.checkpoint.resumable, true);
  assert.ok(resumable.metadata.checkpoint.toolResults?.[0]?.result, 'resumable checkpoint payload preserved');
  assert.ok(resumable.metadata.toolResults[0].input, 'resumable toolResults payload preserved');
  assert.equal(store.canResume('old-failed-resumable'), true, 'still resumable after compaction');

  // --- recent + running: untouched ---
  assert.ok(store.get('recent-completed').metadata.toolResults[0].result, 'recent run untouched');
  assert.ok(store.get('running').metadata.toolResults[0].result, 'in-flight run untouched');

  // --- all runs still queryable ---
  assert.equal(store.list({ limit: 100 }).length, 5);
  assert.equal(store.listByConversationId('conv-1', { limit: 100 }).length, 5);

  // --- full original archived ---
  const archiveDir = join(configDir, 'assistant-core', 'archives');
  assert.ok(existsSync(archiveDir), 'archive dir created');
  const files = readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length >= 1, 'a monthly archive jsonl exists');
  const archived = files
    .flatMap((f) => readFileSync(join(archiveDir, f), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const archivedCompleted = archived.find((r) => r.id === 'old-completed');
  assert.ok(archivedCompleted, 'old-completed archived');
  assert.ok(archivedCompleted.metadata.toolResults[0].result, 'archive retains the FULL heavy payload');
  assert.ok(archivedCompleted.metadata.checkpoint.plan, 'archive retains full checkpoint');
});

test('compactRuns is idempotent and survives a reload without resurrecting heavy fields', () => {
  const configDir = tempDir();
  const store = new AssistantRunStore({ configDir });
  store.save(heavyRun({ id: 'old-completed', status: 'completed', ageDays: 10 }));

  const first = store.compactRuns();
  assert.equal(first.compacted, 1);

  // Second pass: nothing left to do (compacted guard).
  const second = store.compactRuns();
  assert.equal(second.compacted, 0, 'idempotent — no re-archiving');

  // A fresh store reading the same on-disk file sees the SLIMMED record, proving
  // the skipMerge write did not resurrect the heavy fields from disk.
  const reloaded = new AssistantRunStore({ configDir });
  const run = reloaded.get('old-completed');
  assert.equal(run.metadata.compacted, true);
  assert.equal(run.metadata.toolResults[0].input, undefined, 'no resurrection of heavy input after reload');
  assert.equal(run.metadata.checkpoint.toolResults, undefined, 'no resurrection of heavy checkpoint after reload');

  // Archived exactly once (idempotent did not append a duplicate).
  const archiveDir = join(configDir, 'assistant-core', 'archives');
  const archived = readdirSync(archiveDir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(archiveDir, f), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((r) => r.id === 'old-completed');
  assert.equal(archived.length, 1, 'archived exactly once');
});

function jsonLen(value) {
  return JSON.stringify(value).length;
}
