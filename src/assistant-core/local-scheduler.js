import stateCoordinator from './domain/state-coordinator.js';
import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';
import { logger } from '../utils/logger.js';
import { computeNextOccurrenceIso } from './schedule-helpers.js';

function toText(value) {
  return String(value || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function isDue(task = {}, now = Date.now()) {
  // nextRunAt is the SINGLE source of truth. The previous design also
  // consulted a stored UTC anchor (schedule.triggerAt) — which silently
  // made malformed records (anchor pinned to "creation time + 1 second"
  // for a daily reminder) fire on every poll. Under the declarative
  // schedule, anchors no longer exist: nextRunAt is recomputed fresh
  // after every fire from { recurrence, localTime, timezone, ... }.
  if (toText(task?.state) !== 'scheduled') {
    return false;
  }
  const nextRunMs = Date.parse(toText(task?.nextRunAt));
  return Number.isFinite(nextRunMs) && nextRunMs <= now;
}

const DEFAULT_POLL_INTERVAL_MS = 30 * 1000;

export class LocalScheduler {
  constructor({
    stateCoordinator: stateCoordinatorArg = stateCoordinator,
    runner = null,
    messageService = agentOrchestratorMessageService,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    log = logger
  } = {}) {
    this.stateCoordinator = stateCoordinatorArg;
    this.messageService = messageService;
    this.runner = typeof runner === 'function'
      ? runner
      : async (task) => this.messageService.runScheduledTask(task);
    this.pollIntervalMs = Number(pollIntervalMs) > 0 ? Number(pollIntervalMs) : DEFAULT_POLL_INTERVAL_MS;
    this.log = log;
    this._pollTimer = null;
    this._tickInFlight = false;
  }

  /**
   * Start the periodic poll. Idempotent; calling start() while already
   * running is a no-op. Each tick fires runDueTasks(); overlapping ticks
   * are suppressed via _tickInFlight so a long-running task can't pile up
   * concurrent runners.
   */
  start({ pollIntervalMs } = {}) {
    if (this._pollTimer) {
      return;
    }
    if (Number(pollIntervalMs) > 0) {
      this.pollIntervalMs = Number(pollIntervalMs);
    }
    const tick = async () => {
      if (this._tickInFlight) {
        return;
      }
      this._tickInFlight = true;
      try {
        const due = this.listDueTasks();
        if (due.length === 0) {
          return;
        }
        this.log?.info?.(`[LocalScheduler] firing ${due.length} due task(s)`);
        await this.runDueTasks();
      } catch (error) {
        this.log?.warn?.(`[LocalScheduler] tick failed: ${error?.message || error}`);
      } finally {
        this._tickInFlight = false;
      }
    };
    this._pollTimer = setInterval(() => { void tick(); }, this.pollIntervalMs);
    // Don't keep the event loop alive just for the scheduler tick — graceful
    // shutdown should not be blocked by a pending interval.
    if (typeof this._pollTimer.unref === 'function') {
      this._pollTimer.unref();
    }
    // Kick once immediately so a task whose nextRunAt is already in the
    // past doesn't wait a full interval before firing.
    void tick();
  }

  stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  listDueTasks({ now = Date.now(), limit = 50 } = {}) {
    return this.stateCoordinator.scheduledTaskStore.list({ limit: Math.max(1, limit) })
      .filter((task) => isDue(task, now))
      .slice(0, Math.max(1, limit));
  }

  async runDueTasks({ now = Date.now(), limit = 50 } = {}) {
    const tasks = this.listDueTasks({ now, limit });
    const results = [];
    for (const task of tasks) {
      results.push(await this.runTask(task.id, { now }));
    }
    return results;
  }

  async runTask(id = '', { now = Date.now() } = {}) {
    const scheduledTask = this.stateCoordinator.scheduledTaskStore.get(toText(id));
    if (!scheduledTask?.id) {
      throw new Error('scheduled task not found');
    }

    this.stateCoordinator.updateScheduledTaskState({
      id: scheduledTask.id,
      state: 'running',
      patch: {
        lastError: '',
        // Cleared on each fire; the success path below fills in the conversation
        // the run actually used, so stale ids never leak into the run history.
        lastScopeConversationId: ''
      },
      reason: 'local_scheduler_triggered'
    });

    try {
      const result = await this.runner(scheduledTask);
      const recurrence = toText(scheduledTask.schedule?.recurrence) || 'once';
      const firedAt = new Date(now).toISOString();
      // Recompute the next firing from the declarative schedule rather
      // than advancing a stored UTC anchor by 24h. This keeps daily/weekly/
      // monthly/yearly fires correctly aligned to the user's wall-clock
      // time across DST transitions and month-length differences.
      let nextRunAt = '';
      if (recurrence !== 'once') {
        try {
          nextRunAt = computeNextOccurrenceIso(scheduledTask.schedule || {}, { now });
        } catch (computeError) {
          const updated = this.stateCoordinator.updateScheduledTaskState({
            id: scheduledTask.id,
            state: 'failed',
            patch: {
              lastRunAt: firedAt,
              lastError: `next run could not be computed: ${toText(computeError?.message || computeError)}`,
              nextRunAt: ''
            },
            reason: 'local_scheduler_compute_next_failed'
          });
          return {
            task: updated,
            result,
            error: computeError
          };
        }
      }
      const updated = this.stateCoordinator.updateScheduledTaskState({
        id: scheduledTask.id,
        state: recurrence === 'once' ? 'completed' : 'scheduled',
        patch: {
          lastRunAt: firedAt,
          lastResultPreview: toText(result?.summary || result?.result || 'scheduled task completed'),
          nextRunAt,
          // Surface the conversation this fire ran in (runScheduledTask returns
          // scopeConversationId) so the dashboard run history can link to it.
          lastScopeConversationId: toText(result?.scopeConversationId || '')
        },
        reason: 'local_scheduler_success'
      });
      return {
        task: updated,
        result
      };
    } catch (error) {
      const updated = this.stateCoordinator.updateScheduledTaskState({
        id: scheduledTask.id,
        state: 'failed',
        patch: {
          lastRunAt: new Date(now).toISOString(),
          lastError: toText(error?.message || 'scheduled task failed')
        },
        reason: 'local_scheduler_failed'
      });
      return {
        task: updated,
        error
      };
    }
  }

  // Recover tasks left stuck in 'running' by a previous process. A run cannot
  // survive a restart, so a task still marked 'running' at boot means its last
  // fire was interrupted (crash, kill, or a hung command before this fix). Such
  // a task would never fire again (isDue requires state==='scheduled'). Reset
  // recurring tasks to 'scheduled' with a freshly recomputed nextRunAt; mark a
  // stuck one-shot as 'failed' (it already fired once). Call ONCE at startup,
  // before start() — never while ticking (a genuine in-flight task is 'running').
  recoverStuckRunningTasks({ now = Date.now() } = {}) {
    const tasks = this.stateCoordinator.scheduledTaskStore.list({ limit: 1000 });
    let recovered = 0;
    for (const task of tasks) {
      if (toText(task?.state) !== 'running') continue;
      const recurrence = toText(task.schedule?.recurrence) || 'once';
      let nextRunAt = toText(task.nextRunAt);
      if (recurrence !== 'once') {
        try {
          nextRunAt = computeNextOccurrenceIso(task.schedule || {}, { now });
        } catch {
          // keep the existing nextRunAt if recomputation fails
        }
      }
      try {
        this.stateCoordinator.updateScheduledTaskState({
          id: task.id,
          state: recurrence === 'once' ? 'failed' : 'scheduled',
          patch: {
            nextRunAt,
            lastError: 'recovered from an interrupted run (process restart)'
          },
          reason: 'local_scheduler_recover_stuck_running'
        });
        recovered += 1;
      } catch (error) {
        this.log?.warn?.(`[LocalScheduler] failed to recover stuck task ${task.id}: ${error?.message || error}`);
      }
    }
    return recovered;
  }
}

export const localScheduler = new LocalScheduler();

export default localScheduler;
