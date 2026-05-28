import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAssistantRunToolHandlers } from '../../src/assistant-tools/handlers/assistant-runs.js';
import { createDesktopWaitToolHandlers } from '../../src/assistant-tools/handlers/desktop-wait.js';
import { ASSISTANT_RUN_STATUS } from '../../src/assistant-core/models.js';

function makeRun({ id, status }) {
  return {
    id,
    status,
    metadata: {
      stopPolicy: { status, closure: status, reason: 'unit_test_seed' }
    }
  };
}

function makeFakeRunStore(initial = []) {
  const map = new Map(initial.map((entry) => [entry.id, entry]));
  return {
    get(id) {
      return map.get(String(id || '')) || null;
    },
    save(run) {
      map.set(String(run.id || ''), run);
      return run;
    }
  };
}

function makeFakeEventStore() {
  const events = [];
  return {
    events,
    append(runId, event) {
      events.push({ runId, ...event });
      return event;
    }
  };
}

test('cancel_assistant_run flips an active run to cancelled and emits a run event', async () => {
  const runStore = makeFakeRunStore([
    makeRun({ id: 'run-active-1', status: ASSISTANT_RUN_STATUS.RUNNING })
  ]);
  const eventStore = makeFakeEventStore();
  const handlers = createAssistantRunToolHandlers({ runStore, runEventStore: eventStore });

  const result = await handlers.cancelAssistantRun({
    input: { runId: 'run-active-1', reason: 'user said 算了' }
  });

  assert.equal(result.ok, true);
  assert.equal(result.runId, 'run-active-1');
  assert.equal(result.previousStatus, ASSISTANT_RUN_STATUS.RUNNING);
  assert.equal(result.status, ASSISTANT_RUN_STATUS.CANCELLED);
  assert.equal(runStore.get('run-active-1').status, ASSISTANT_RUN_STATUS.CANCELLED);
  assert.equal(runStore.get('run-active-1').metadata.stopPolicy.reason, 'assistant_supervisor_cancel');
  assert.equal(runStore.get('run-active-1').metadata.cancellation.reason, 'user said 算了');
  assert.equal(eventStore.events.length, 1);
  assert.equal(eventStore.events[0].type, 'assistant.run.cancelled');
  assert.equal(eventStore.events[0].runId, 'run-active-1');
});

test('cancel_assistant_run is idempotent on already-terminal runs', async () => {
  const runStore = makeFakeRunStore([
    makeRun({ id: 'run-done-1', status: ASSISTANT_RUN_STATUS.COMPLETED })
  ]);
  const eventStore = makeFakeEventStore();
  const handlers = createAssistantRunToolHandlers({ runStore, runEventStore: eventStore });

  const result = await handlers.cancelAssistantRun({
    input: { runId: 'run-done-1', reason: 'defensive cancel' }
  });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyTerminal, true);
  assert.equal(result.status, ASSISTANT_RUN_STATUS.COMPLETED);
  // No status flip, no event spam — terminal stays terminal.
  assert.equal(runStore.get('run-done-1').status, ASSISTANT_RUN_STATUS.COMPLETED);
  assert.equal(eventStore.events.length, 0);
});

test('cancel_assistant_run returns RUN_NOT_FOUND for missing runs', async () => {
  const runStore = makeFakeRunStore([]);
  const handlers = createAssistantRunToolHandlers({ runStore, runEventStore: makeFakeEventStore() });

  const result = await handlers.cancelAssistantRun({
    input: { runId: 'run-missing-1' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUN_NOT_FOUND');
});

test('cancel_assistant_run rejects missing runId input', async () => {
  const handlers = createAssistantRunToolHandlers({
    runStore: makeFakeRunStore([]),
    runEventStore: makeFakeEventStore()
  });
  await assert.rejects(
    () => handlers.cancelAssistantRun({ input: {} }),
    (err) => err.code === 'INVALID_INPUT'
  );
});

test('desktop_wait_for_file returns matched as soon as the file appears', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wait-file-'));
  const target = join(tmp, 'expected.bin');
  // Schedule the file to appear ~120 ms in.
  setTimeout(() => {
    writeFileSync(target, 'hello-from-wait-for-file');
  }, 120);

  try {
    const runStore = makeFakeRunStore([
      makeRun({ id: 'run-wait-1', status: ASSISTANT_RUN_STATUS.RUNNING })
    ]);
    const handlers = createDesktopWaitToolHandlers({
      desktopClient: { listWindows: async () => ({ windows: [] }) },
      runStore
    });

    const result = await handlers.desktopWaitForFile({
      input: { path: target, timeoutMs: 4000, pollMs: 250 },
      context: { run: { id: 'run-wait-1' } }
    });

    assert.equal(result.matched, true);
    assert.equal(result.action, 'wait_for_file');
    assert.equal(result.details.isFile, true);
    assert.ok(result.attempts >= 1);
  } finally {
    try { unlinkSync(target); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('desktop_wait_for_file times out without matched when the file never appears', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wait-file-miss-'));
  const target = join(tmp, 'never-appears.bin');
  try {
    const runStore = makeFakeRunStore([
      makeRun({ id: 'run-wait-miss-1', status: ASSISTANT_RUN_STATUS.RUNNING })
    ]);
    const handlers = createDesktopWaitToolHandlers({
      desktopClient: { listWindows: async () => ({ windows: [] }) },
      runStore
    });

    const result = await handlers.desktopWaitForFile({
      input: { path: target, timeoutMs: 350, pollMs: 250 },
      context: { run: { id: 'run-wait-miss-1' } }
    });

    assert.equal(result.matched, false);
    assert.equal(result.timedOut, true);
    assert.ok(result.attempts >= 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('desktop_wait_for_file aborts immediately when the originating run is cancelled', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wait-file-cancel-'));
  const target = join(tmp, 'never-appears-cancelled.bin');
  try {
    const run = makeRun({ id: 'run-wait-cancel-1', status: ASSISTANT_RUN_STATUS.RUNNING });
    const runStore = makeFakeRunStore([run]);
    const handlers = createDesktopWaitToolHandlers({
      desktopClient: { listWindows: async () => ({ windows: [] }) },
      runStore
    });
    // Cancel the run while wait is in flight.
    setTimeout(() => {
      runStore.save({ ...runStore.get('run-wait-cancel-1'), status: ASSISTANT_RUN_STATUS.CANCELLED });
    }, 120);

    await assert.rejects(
      () => handlers.desktopWaitForFile({
        input: { path: target, timeoutMs: 5000, pollMs: 250 },
        context: { run: { id: 'run-wait-cancel-1' } }
      }),
      (err) => err.code === 'RUN_CANCELLED'
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('desktop_wait_for_window matches against the live desktop_list_windows result', async () => {
  const runStore = makeFakeRunStore([
    makeRun({ id: 'run-wait-win-1', status: ASSISTANT_RUN_STATUS.RUNNING })
  ]);
  let listCalls = 0;
  const desktopClient = {
    listWindows: async () => {
      listCalls += 1;
      if (listCalls < 3) return { windows: [{ hwnd: 1, title: 'Some other window', class: 'X', pid: 1 }] };
      return { windows: [{ hwnd: 42, title: '飞书 安装向导', class: 'InstallerWnd', pid: 100 }] };
    }
  };
  const handlers = createDesktopWaitToolHandlers({ desktopClient, runStore });

  const result = await handlers.desktopWaitForWindow({
    input: { title: '飞书', timeoutMs: 4000, pollMs: 100 },
    context: { run: { id: 'run-wait-win-1' } }
  });

  assert.equal(result.matched, true);
  assert.equal(result.details.hwnd, 42);
  assert.equal(result.details.title, '飞书 安装向导');
});
