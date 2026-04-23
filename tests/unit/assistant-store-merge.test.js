import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mergeJsonRecords } from '../../src/assistant-core/merge-json-records.js';
import { AssistantRunStore } from '../../src/assistant-core/run-store.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('mergeJsonRecords preserves distinct records from disk and current memory', () => {
  const merged = mergeJsonRecords({
    diskRecords: [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 }
    ],
    currentRecords: [
      { id: 'b', value: 3 },
      { id: 'c', value: 4 }
    ],
    keyOf: (entry) => entry.id
  });

  assert.equal(merged.length, 3);
  assert.equal(merged.find((entry) => entry.id === 'a')?.value, 1);
  assert.equal(merged.find((entry) => entry.id === 'b')?.value, 3);
  assert.equal(merged.find((entry) => entry.id === 'c')?.value, 4);
});

test('AssistantRunStore merge-on-write keeps records from another store instance', () => {
  const configDir = createTempDir('cligate-assistant-store-merge-');
  const storeA = new AssistantRunStore({ configDir });
  const storeB = new AssistantRunStore({ configDir });

  const runA = storeA.create({
    assistantSessionId: 's1',
    conversationId: 'c1',
    triggerText: 'first'
  });
  const runB = storeB.create({
    assistantSessionId: 's2',
    conversationId: 'c2',
    triggerText: 'second'
  });

  const reloaded = new AssistantRunStore({ configDir });
  const ids = reloaded.list({ limit: 10 }).map((entry) => entry.id);
  assert.ok(ids.includes(runA.id));
  assert.ok(ids.includes(runB.id));
});
