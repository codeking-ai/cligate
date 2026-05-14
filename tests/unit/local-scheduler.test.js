import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentChannelConversationStore } from '../../src/agent-channels/conversation-store.js';
import { StateCoordinator } from '../../src/assistant-core/domain/state-coordinator.js';
import { PersonStore } from '../../src/assistant-core/domain/person-store.js';
import { ProjectStore } from '../../src/assistant-core/domain/project-store.js';
import { TaskStore } from '../../src/assistant-core/domain/task-store.js';
import { ExecutionStore } from '../../src/assistant-core/domain/execution-store.js';
import { ScheduledTaskStore } from '../../src/assistant-core/domain/scheduled-task-store.js';
import { EpisodeLedger } from '../../src/assistant-core/domain/episode-ledger.js';
import { LocalScheduler } from '../../src/assistant-core/local-scheduler.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createCoordinator() {
  const configDir = createTempDir('cligate-local-scheduler-');
  const conversationStore = new AgentChannelConversationStore({ configDir });
  const coordinator = new StateCoordinator({
    conversationStore,
    personStore: new PersonStore({ configDir }),
    projectStore: new ProjectStore({ configDir }),
    taskStore: new TaskStore({ configDir }),
    executionStore: new ExecutionStore({ configDir }),
    scheduledTaskStore: new ScheduledTaskStore({ configDir }),
    episodeLedger: new EpisodeLedger({ configDir })
  });
  return { conversationStore, coordinator };
}

test('LocalScheduler runs a once reminder and marks it completed', async () => {
  const { conversationStore, coordinator } = createCoordinator();
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'chat-ui',
    accountId: 'default',
    externalConversationId: 'local-scheduler-once',
    externalUserId: 'user-1',
    title: 'once reminder'
  });
  const scheduledTask = coordinator.createScheduledTask({
    kind: 'reminder',
    title: 'Once reminder',
    schedule: { recurrence: 'once', delayMinutes: 5, timezone: 'Asia/Shanghai' },
    payload: { conversationId: conversation.id, message: 'do the thing' },
    now: Date.parse('2026-05-14T10:00:00.000Z')
  });

  // The store should have a precomputed nextRunAt 5 minutes in the future.
  assert.equal(scheduledTask.nextRunAt, '2026-05-14T10:05:00.000Z');

  const scheduler = new LocalScheduler({
    stateCoordinator: coordinator,
    runner: async () => ({ summary: 'fired' })
  });
  const [result] = await scheduler.runDueTasks({
    now: Date.parse('2026-05-14T10:10:00.000Z')
  });

  assert.equal(result.task.state, 'completed');
  assert.equal(result.task.nextRunAt, '');
});

test('LocalScheduler records failed lifecycle when runner throws', async () => {
  const { conversationStore, coordinator } = createCoordinator();
  conversationStore.findOrCreateByExternal({
    channel: 'chat-ui',
    accountId: 'default',
    externalConversationId: 'local-scheduler-failed',
    externalUserId: 'user-2',
    title: 'failed reminder'
  });
  const scheduledTask = coordinator.createScheduledTask({
    kind: 'reminder',
    title: 'Run and fail',
    schedule: { recurrence: 'once', delaySeconds: 1 },
    now: Date.parse('2026-05-14T10:00:00.000Z')
  });

  const scheduler = new LocalScheduler({
    stateCoordinator: coordinator,
    runner: async () => { throw new Error('boom'); }
  });
  const [result] = await scheduler.runDueTasks({
    now: Date.parse('2026-05-14T10:00:30.000Z')
  });

  assert.equal(result.task.state, 'failed');
  assert.match(String(result.task.lastError || ''), /boom/);
  const failed = coordinator.episodeLedger.listByEntity({
    kind: 'scheduled_task.failed',
    limit: 10
  });
  assert.ok(failed.length >= 1);
});

test('LocalScheduler advances a daily reminder to tomorrow\'s same wall-clock time', async () => {
  const { coordinator } = createCoordinator();
  // 20:00 Asia/Shanghai = 12:00 UTC. now = 11:00 UTC → today's 12:00 UTC is the
  // first fire.
  const scheduledTask = coordinator.createScheduledTask({
    kind: 'reminder',
    title: 'Daily 20:00',
    schedule: { recurrence: 'daily', localTime: '20:00', timezone: 'Asia/Shanghai' },
    now: Date.parse('2026-05-14T11:00:00.000Z')
  });
  assert.equal(scheduledTask.nextRunAt, '2026-05-14T12:00:00.000Z');

  const scheduler = new LocalScheduler({
    stateCoordinator: coordinator,
    runner: async () => ({ summary: 'fired' })
  });
  const [result] = await scheduler.runDueTasks({
    now: Date.parse('2026-05-14T12:00:30.000Z')
  });

  assert.equal(result.task.state, 'scheduled');
  // Next fire must be tomorrow's 20:00 Beijing = 2026-05-15 12:00 UTC.
  assert.equal(result.task.nextRunAt, '2026-05-15T12:00:00.000Z');
});

test('REGRESSION: daily reminder does NOT re-fire within the same day after one trigger', async () => {
  // This was the user-visible bug: triggerAt got pinned to "creation time
  // + 1 second", so the daily reminder fired on the next poll and then
  // again every 30s. With nextRunAt as single source of truth + DST-safe
  // recompute, the second fire must wait for tomorrow.
  const { coordinator } = createCoordinator();
  const scheduledTask = coordinator.createScheduledTask({
    kind: 'reminder',
    title: 'Daily 20:00',
    schedule: { recurrence: 'daily', localTime: '20:00', timezone: 'Asia/Shanghai' },
    now: Date.parse('2026-05-14T11:00:00.000Z')
  });
  let runs = 0;
  const scheduler = new LocalScheduler({
    stateCoordinator: coordinator,
    runner: async () => { runs += 1; return { summary: 'fired' }; }
  });
  await scheduler.runDueTasks({ now: Date.parse('2026-05-14T12:00:30.000Z') });
  assert.equal(runs, 1);

  // Poll 30 times across the rest of the day — none should re-fire.
  for (let i = 1; i <= 30; i += 1) {
    await scheduler.runDueTasks({
      now: Date.parse('2026-05-14T12:00:30.000Z') + i * 30 * 60_000
    });
  }
  assert.equal(runs, 1);

  // Now jump to tomorrow's 20:00 Beijing — should fire once more.
  await scheduler.runDueTasks({ now: Date.parse('2026-05-15T12:00:30.000Z') });
  assert.equal(runs, 2);
  const refreshed = coordinator.scheduledTaskStore.get(scheduledTask.id);
  assert.equal(refreshed.nextRunAt, '2026-05-16T12:00:00.000Z');
});

test('LocalScheduler handles weekly with multiple dayOfWeek entries', async () => {
  const { coordinator } = createCoordinator();
  // 2026-05-14 is a Thursday. Weekly mon/wed/fri @ 09:00 Beijing.
  const scheduledTask = coordinator.createScheduledTask({
    kind: 'reminder',
    title: 'Weekly MWF 09:00',
    schedule: { recurrence: 'weekly', dayOfWeek: ['mon', 'wed', 'fri'], localTime: '09:00', timezone: 'Asia/Shanghai' },
    now: Date.parse('2026-05-14T10:00:00.000Z')
  });
  // Next fire: Friday 2026-05-15 09:00 Beijing = 01:00 UTC.
  assert.equal(scheduledTask.nextRunAt, '2026-05-15T01:00:00.000Z');

  const scheduler = new LocalScheduler({
    stateCoordinator: coordinator,
    runner: async () => ({ summary: 'fired' })
  });
  await scheduler.runDueTasks({ now: Date.parse('2026-05-15T01:01:00.000Z') });
  const afterFri = coordinator.scheduledTaskStore.get(scheduledTask.id);
  // After Fri 2026-05-15, next is Mon 2026-05-18 09:00 Beijing = 01:00 UTC.
  assert.equal(afterFri.nextRunAt, '2026-05-18T01:00:00.000Z');
});

test('LocalScheduler handles monthly with dayOfMonth that skips short months', async () => {
  const { coordinator } = createCoordinator();
  const scheduledTask = coordinator.createScheduledTask({
    kind: 'reminder',
    title: 'Monthly 31st',
    schedule: { recurrence: 'monthly', dayOfMonth: 31, localTime: '09:00', timezone: 'Asia/Shanghai' },
    now: Date.parse('2026-05-30T00:00:00.000Z')
  });
  // First fire: 2026-05-31 09:00 Beijing = 01:00 UTC.
  assert.equal(scheduledTask.nextRunAt, '2026-05-31T01:00:00.000Z');

  const scheduler = new LocalScheduler({
    stateCoordinator: coordinator,
    runner: async () => ({ summary: 'fired' })
  });
  await scheduler.runDueTasks({ now: Date.parse('2026-05-31T01:01:00.000Z') });
  const afterMay = coordinator.scheduledTaskStore.get(scheduledTask.id);
  // June has only 30 days → next 31 is July 31.
  assert.equal(afterMay.nextRunAt, '2026-07-31T01:00:00.000Z');
});

test('LocalScheduler handles yearly schedules', async () => {
  const { coordinator } = createCoordinator();
  const scheduledTask = coordinator.createScheduledTask({
    kind: 'reminder',
    title: 'Annual New Year',
    schedule: { recurrence: 'yearly', month: 1, dayOfMonth: 1, localTime: '00:00', timezone: 'Asia/Shanghai' },
    now: Date.parse('2026-05-14T00:00:00.000Z')
  });
  // 2027-01-01 00:00 Beijing = 2026-12-31 16:00 UTC.
  assert.equal(scheduledTask.nextRunAt, '2026-12-31T16:00:00.000Z');
});

test('updateScheduledTask recomputes nextRunAt and keeps existing payload', async () => {
  const { conversationStore, coordinator } = createCoordinator();
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'chat-ui',
    accountId: 'default',
    externalConversationId: 'local-scheduler-update',
    externalUserId: 'user-u',
    title: 'updatable reminder'
  });
  const created = coordinator.createScheduledTask({
    kind: 'reminder',
    title: 'Bedtime',
    schedule: { recurrence: 'daily', localTime: '22:15', timezone: 'Asia/Shanghai' },
    payload: { conversationId: conversation.id, message: '宝贝该睡觉了' },
    now: Date.parse('2026-05-14T10:00:00.000Z')
  });
  // Original next fire: 22:15 Beijing = 14:15 UTC.
  assert.equal(created.nextRunAt, '2026-05-14T14:15:00.000Z');

  const updated = coordinator.updateScheduledTask({
    id: created.id,
    schedule: { recurrence: 'daily', localTime: '22:25', timezone: 'Asia/Shanghai' },
    now: Date.parse('2026-05-14T10:00:00.000Z')
  });
  // New next fire: 22:25 Beijing = 14:25 UTC.
  assert.equal(updated.nextRunAt, '2026-05-14T14:25:00.000Z');
  // Message stays.
  assert.equal(updated.payload.message, '宝贝该睡觉了');
  // Same id, no duplicate.
  assert.equal(updated.id, created.id);
  assert.equal(coordinator.scheduledTaskStore.list({ limit: 10 }).length, 1);
});

test('cancelScheduledTask transitions the task to cancelled and clears nextRunAt', async () => {
  const { coordinator } = createCoordinator();
  const created = coordinator.createScheduledTask({
    kind: 'reminder',
    title: 'To be cancelled',
    schedule: { recurrence: 'daily', localTime: '07:00', timezone: 'Asia/Shanghai' },
    now: Date.parse('2026-05-14T10:00:00.000Z')
  });
  const cancelled = coordinator.cancelScheduledTask({ id: created.id, reason: 'user_changed_mind' });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.nextRunAt, '');

  // A cancelled task must not fire even if its nextRunAt was in the past.
  let runs = 0;
  const scheduler = new LocalScheduler({
    stateCoordinator: coordinator,
    runner: async () => { runs += 1; return { summary: 'fired' }; }
  });
  await scheduler.runDueTasks({ now: Date.parse('2026-05-20T00:00:00.000Z') });
  assert.equal(runs, 0);
});

test('LocalScheduler.start() polls due tasks on an interval', async () => {
  const { coordinator } = createCoordinator();
  const created = coordinator.createScheduledTask({
    kind: 'reminder',
    title: 'Polled task',
    schedule: { recurrence: 'once', delayMinutes: 60 },
    now: Date.parse('2020-01-01T00:00:00.000Z')
  });
  // Force nextRunAt to the past so the very first poll fires it.
  coordinator.updateScheduledTaskState({
    id: created.id,
    state: 'scheduled',
    patch: { nextRunAt: '2020-01-01T00:00:00.000Z' },
    reason: 'test_force_past'
  });

  let runs = 0;
  const scheduler = new LocalScheduler({
    stateCoordinator: coordinator,
    runner: async () => { runs += 1; return { summary: 'fired by poll' }; },
    pollIntervalMs: 50,
    log: { info() {}, warn() {} }
  });
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  scheduler.stop();

  assert.equal(runs, 1);
  const refreshed = coordinator.scheduledTaskStore.get(created.id);
  assert.equal(refreshed.state, 'completed');
});

test('LocalScheduler.start() is idempotent and stop() halts further ticks', async () => {
  const { coordinator } = createCoordinator();
  let runs = 0;
  const scheduler = new LocalScheduler({
    stateCoordinator: coordinator,
    runner: async () => { runs += 1; return { summary: 'noop' }; },
    pollIntervalMs: 50,
    log: { info() {}, warn() {} }
  });
  scheduler.start();
  scheduler.start();
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  scheduler.stop();
  assert.equal(runs, 0);
  assert.equal(scheduler._pollTimer, null);
});

test('LocalScheduler defaults to messageService.runScheduledTask when no custom runner is provided', async () => {
  const { coordinator } = createCoordinator();
  const created = coordinator.createScheduledTask({
    kind: 'reminder',
    title: 'Via message service',
    schedule: { recurrence: 'once', delayMinutes: 1 },
    now: Date.parse('2026-05-14T10:00:00.000Z')
  });

  const scheduler = new LocalScheduler({
    stateCoordinator: coordinator,
    messageService: {
      async runScheduledTask(taskInput) {
        assert.equal(taskInput.id, created.id);
        return { summary: 'message service runner ok' };
      }
    }
  });
  const [result] = await scheduler.runDueTasks({
    now: Date.parse('2026-05-14T10:01:30.000Z')
  });
  assert.equal(result.task.state, 'completed');
  assert.equal(result.result.summary, 'message service runner ok');
});
