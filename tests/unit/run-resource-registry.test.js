import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RunResourceRegistry,
  DESKTOP_INPUT_TOOLS,
  DESKTOP_RESOURCE
} from '../../src/assistant-core/run-resource-registry.js';
import runResourceRegistry from '../../src/assistant-core/run-resource-registry.js';
import AssistantReactEngine from '../../src/assistant-agent/react-engine.js';
import assistantRunStore from '../../src/assistant-core/run-store.js';
import { ASSISTANT_RUN_STATUS } from '../../src/assistant-core/models.js';

// A minimal fake run-store: maps runId -> { status }. Used so the registry can
// cross-check whether a lease holder is still alive.
function makeRunStore(records = {}) {
  return {
    set(id, status) { records[id] = { id, status }; },
    get(id) { return records[id] || null; }
  };
}

test('tryAcquire grants a free resource and blocks a second run', () => {
  const store = makeRunStore({ 'run-a': { id: 'run-a', status: 'running' }, 'run-b': { id: 'run-b', status: 'running' } });
  const reg = new RunResourceRegistry({ runStore: store });

  const a = reg.tryAcquire(DESKTOP_RESOURCE, 'run-a', { title: 'login' });
  assert.equal(a.ok, true);
  assert.equal(a.acquired, true);

  const b = reg.tryAcquire(DESKTOP_RESOURCE, 'run-b', { title: 'other login' });
  assert.equal(b.ok, false);
  assert.equal(b.holder.runId, 'run-a');
  assert.equal(b.holder.info.title, 'login');
});

test('the holder can re-acquire its own lease (idempotent heartbeat)', () => {
  const store = makeRunStore({ 'run-a': { id: 'run-a', status: 'running' } });
  const reg = new RunResourceRegistry({ runStore: store });
  reg.tryAcquire(DESKTOP_RESOURCE, 'run-a');
  const again = reg.tryAcquire(DESKTOP_RESOURCE, 'run-a');
  assert.equal(again.ok, true);
  assert.equal(again.acquired, false);
});

test('release frees the resource so a queued run can take it', () => {
  const store = makeRunStore({ 'run-a': { id: 'run-a', status: 'running' }, 'run-b': { id: 'run-b', status: 'running' } });
  const reg = new RunResourceRegistry({ runStore: store });
  reg.tryAcquire(DESKTOP_RESOURCE, 'run-a');
  assert.equal(reg.tryAcquire(DESKTOP_RESOURCE, 'run-b').ok, false);

  assert.equal(reg.release(DESKTOP_RESOURCE, 'run-a'), true);
  const b = reg.tryAcquire(DESKTOP_RESOURCE, 'run-b');
  assert.equal(b.ok, true);
  assert.equal(b.acquired, true);
});

test('release is a no-op when a non-holder calls it', () => {
  const store = makeRunStore({ 'run-a': { id: 'run-a', status: 'running' } });
  const reg = new RunResourceRegistry({ runStore: store });
  reg.tryAcquire(DESKTOP_RESOURCE, 'run-a');
  assert.equal(reg.release(DESKTOP_RESOURCE, 'run-zzz'), false);
  // run-a still holds it.
  assert.equal(reg.tryAcquire(DESKTOP_RESOURCE, 'run-b').ok, false);
});

test('releaseAllForRun frees every resource held by a run', () => {
  const store = makeRunStore({ 'run-a': { id: 'run-a', status: 'running' } });
  const reg = new RunResourceRegistry({ runStore: store });
  reg.tryAcquire(DESKTOP_RESOURCE, 'run-a');
  reg.tryAcquire('fs:D:/proj', 'run-a');
  const freed = reg.releaseAllForRun('run-a');
  assert.equal(freed, 2);
  assert.equal(reg.getHolder(DESKTOP_RESOURCE), null);
});

test('stale reclaim: a terminal holder is evicted so the next run can acquire', () => {
  const store = makeRunStore({ 'run-dead': { id: 'run-dead', status: 'running' }, 'run-new': { id: 'run-new', status: 'running' } });
  const reg = new RunResourceRegistry({ runStore: store });
  reg.tryAcquire(DESKTOP_RESOURCE, 'run-dead');

  // The holder run reaches a terminal state without ever releasing (crash / lost).
  store.set('run-dead', 'failed');

  const acq = reg.tryAcquire(DESKTOP_RESOURCE, 'run-new');
  assert.equal(acq.ok, true, 'a dead holder must not wedge the desktop forever');
  assert.equal(acq.acquired, true);
});

test('stale reclaim: a missing holder run is evicted', () => {
  const store = makeRunStore({ 'run-new': { id: 'run-new', status: 'running' } });
  const reg = new RunResourceRegistry({ runStore: store });
  reg.tryAcquire(DESKTOP_RESOURCE, 'ghost-run'); // never recorded in the store
  const acq = reg.tryAcquire(DESKTOP_RESOURCE, 'run-new');
  assert.equal(acq.ok, true);
});

test('TTL reclaim: a holder past max-hold with a stale heartbeat is evicted', () => {
  let nowMs = 0;
  const store = makeRunStore({ 'run-stuck': { id: 'run-stuck', status: 'running' }, 'run-new': { id: 'run-new', status: 'running' } });
  const reg = new RunResourceRegistry({ runStore: store, maxHoldMs: 1000, staleHeartbeatMs: 500, now: () => nowMs });
  reg.tryAcquire(DESKTOP_RESOURCE, 'run-stuck'); // acquiredAt = 0, lastHeartbeat = 0

  nowMs = 2000; // > maxHold AND heartbeat silent > staleHeartbeat
  const acq = reg.tryAcquire(DESKTOP_RESOURCE, 'run-new');
  assert.equal(acq.ok, true, 'a stuck holder must be reclaimed after the TTL');
});

test('TTL: a recent heartbeat keeps the lease alive past max-hold', () => {
  let nowMs = 0;
  const store = makeRunStore({ 'run-busy': { id: 'run-busy', status: 'running' }, 'run-new': { id: 'run-new', status: 'running' } });
  const reg = new RunResourceRegistry({ runStore: store, maxHoldMs: 1000, staleHeartbeatMs: 500, now: () => nowMs });
  reg.tryAcquire(DESKTOP_RESOURCE, 'run-busy');

  nowMs = 1200;
  reg.heartbeat(DESKTOP_RESOURCE, 'run-busy'); // lastHeartbeat = 1200
  nowMs = 1300; // held 1300>1000 BUT heartbeat only 100ms ago (<500) → still alive
  const acq = reg.tryAcquire(DESKTOP_RESOURCE, 'run-new');
  assert.equal(acq.ok, false, 'an actively-heartbeating holder must keep its lease');
});

test('fail-open: a throwing run-store never wedges acquisition', () => {
  const reg = new RunResourceRegistry({ runStore: { get() { throw new Error('store boom'); } } });
  const a = reg.tryAcquire(DESKTOP_RESOURCE, 'run-a');
  assert.equal(a.ok, true);
  // Even with a holder recorded, a throwing liveness check resolves to "free".
  const b = reg.tryAcquire(DESKTOP_RESOURCE, 'run-b');
  assert.equal(b.ok, true);
});

test('describe() reports held resources for prompt surfacing', () => {
  const store = makeRunStore({ 'run-a': { id: 'run-a', status: 'running' } });
  const reg = new RunResourceRegistry({ runStore: store });
  assert.deepEqual(reg.describe(), {});
  reg.tryAcquire(DESKTOP_RESOURCE, 'run-a', { title: 'crewplus login', conversationId: 'c-1' });
  const snap = reg.describe();
  assert.equal(snap[DESKTOP_RESOURCE].runId, 'run-a');
  assert.equal(snap[DESKTOP_RESOURCE].title, 'crewplus login');
  assert.equal(snap[DESKTOP_RESOURCE].conversationId, 'c-1');
});

test('DESKTOP_INPUT_TOOLS gates input-grabbing tools but not read-only ones', () => {
  // Input-grabbing → must serialize.
  for (const name of ['desktop_click_at', 'desktop_type_text', 'desktop_hotkey', 'desktop_fill_text_field', 'desktop_launch_app', 'desktop_focus_window']) {
    assert.equal(DESKTOP_INPUT_TOOLS.has(name), true, `${name} should require the desktop lease`);
  }
  // Read-only → safe to run while another task holds the desktop.
  for (const name of ['desktop_health', 'desktop_list_windows', 'desktop_capture_window', 'desktop_inspect_window', 'desktop_find_text', 'desktop_wait_for_window']) {
    assert.equal(DESKTOP_INPUT_TOOLS.has(name), false, `${name} should NOT require the desktop lease`);
  }
});

// --- react-engine desktop lease gate ---------------------------------------

test('ensureDesktopLease acquires immediately when the desktop is free', async () => {
  runResourceRegistry.reset();
  // The registry singleton cross-checks holder liveness against the real run
  // store (in production the run is persisted before it ever runs), so seed it.
  assistantRunStore.save({ id: 'run-free', conversationId: 'c-1', status: ASSISTANT_RUN_STATUS.RUNNING });
  const engine = new AssistantReactEngine({
    llmClient: {}, toolRegistry: { list: () => [] }, toolExecutor: {},
    runStore: assistantRunStore
  });
  const gate = await engine.ensureDesktopLease({ id: 'run-free', triggerText: 'login' }, { id: 'c-1' }, 'run-free');
  assert.equal(gate.ok, true);
  assert.equal(gate.waitedMs, 0);
  assert.equal(runResourceRegistry.getHolder(DESKTOP_RESOURCE).runId, 'run-free');
  runResourceRegistry.reset();
});

test('ensureDesktopLease returns promptly (cancelled) when the run is cancelled while the desktop is busy', async () => {
  runResourceRegistry.reset();
  assistantRunStore.save({ id: 'holder-run', conversationId: 'c-1', status: ASSISTANT_RUN_STATUS.RUNNING });
  assistantRunStore.save({ id: 'run-cxl', conversationId: 'c-1', status: ASSISTANT_RUN_STATUS.CANCELLED });
  // Another (live) run holds the desktop.
  runResourceRegistry.tryAcquire(DESKTOP_RESOURCE, 'holder-run', { title: 'busy holder' });
  const engine = new AssistantReactEngine({
    llmClient: {}, toolRegistry: { list: () => [] }, toolExecutor: {},
    runStore: assistantRunStore
  });
  const startedAt = Date.now();
  const gate = await engine.ensureDesktopLease({ id: 'run-cxl', triggerText: 'second login' }, { id: 'c-1' }, 'run-cxl');
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'cancelled');
  assert.ok(Date.now() - startedAt < 4000, 'a cancelled wait must not block on the full poll window');
  // The holder still owns the desktop (our cancelled run never took it).
  assert.equal(runResourceRegistry.getHolder(DESKTOP_RESOURCE).runId, 'holder-run');
  runResourceRegistry.reset();
});
