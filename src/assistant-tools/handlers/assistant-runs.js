import assistantRunStore from '../../assistant-core/run-store.js';
import assistantRunEventStore from '../../assistant-core/run-event-store.js';
import { ASSISTANT_RUN_STATUS, ASSISTANT_RUN_CLOSURE_STATE } from '../../assistant-core/models.js';

const ACTIVE_RUN_STATUSES = new Set([
  ASSISTANT_RUN_STATUS.QUEUED,
  ASSISTANT_RUN_STATUS.RUNNING,
  ASSISTANT_RUN_STATUS.WAITING_RUNTIME,
  ASSISTANT_RUN_STATUS.WAITING_USER
]);

function normalizeText(value) {
  return String(value || '').trim();
}

// Mark an in-flight assistant run as cancelled so the supervisor LLM can stop
// a concurrent run before issuing its own mutating tool calls. The runner /
// dialogue loop and any blocking wait_for_* tool should check the run's status
// between iterations and bail out when they see "cancelled". This handler is
// idempotent: if the run is already in a terminal state, we return the existing
// status without throwing — the LLM may call this defensively when it's not
// 100% sure the run is still alive.
export function createAssistantRunToolHandlers({
  runStore = assistantRunStore,
  runEventStore = assistantRunEventStore
} = {}) {
  return {
    cancelAssistantRun: async ({ input = {}, context = {} } = {}) => {
      const runId = normalizeText(input?.runId);
      if (!runId) {
        const error = new Error('cancel_assistant_run requires runId');
        error.code = 'INVALID_INPUT';
        throw error;
      }
      const reason = normalizeText(input?.reason) || 'cancelled by supervisor';

      // Self-cancellation guard. The supervisor's own run appears as a live run
      // in the conversation; if the LLM mistakes it for a "duplicate" and passes
      // its own runId here, cancelling it would abort the very loop issuing the
      // call (this is exactly the 2026-06-02 DingTalk self-cancel incident).
      // Refuse it loudly instead of silently committing suicide.
      const callerRunId = normalizeText(context?.run?.id);
      if (callerRunId && runId === callerRunId) {
        return {
          ok: false,
          code: 'CANNOT_CANCEL_SELF',
          runId,
          error: `cannot cancel run ${runId}: it is the run you are currently executing in. `
            + 'You are not a duplicate of yourself — proceed with the task instead of cancelling.'
        };
      }

      const run = runStore.get(runId);
      if (!run) {
        return {
          ok: false,
          error: `assistant run ${runId} not found`,
          code: 'RUN_NOT_FOUND'
        };
      }

      const currentStatus = normalizeText(run.status);
      if (!ACTIVE_RUN_STATUSES.has(currentStatus)) {
        return {
          ok: true,
          alreadyTerminal: true,
          runId,
          previousStatus: currentStatus,
          status: currentStatus,
          message: `assistant run ${runId} was already in terminal state ${currentStatus}; nothing to cancel`
        };
      }

      const updated = runStore.save({
        ...run,
        status: ASSISTANT_RUN_STATUS.CANCELLED,
        metadata: {
          ...(run.metadata || {}),
          stopPolicy: {
            ...((run.metadata?.stopPolicy && typeof run.metadata.stopPolicy === 'object')
              ? run.metadata.stopPolicy
              : {}),
            status: ASSISTANT_RUN_STATUS.CANCELLED,
            closure: ASSISTANT_RUN_CLOSURE_STATE.CANCELLED,
            reason: 'assistant_supervisor_cancel'
          },
          cancellation: {
            cancelledAt: new Date().toISOString(),
            reason,
            source: 'supervisor_tool'
          }
        }
      });

      try {
        runEventStore?.append?.(runId, {
          type: 'assistant.run.cancelled',
          phase: 'finish',
          status: ASSISTANT_RUN_STATUS.CANCELLED,
          title: 'Assistant run cancelled by supervisor',
          summary: reason,
          payload: {
            reason,
            source: 'supervisor_tool',
            previousStatus: currentStatus
          },
          visibility: 'compact'
        });
      } catch {
        // Event store failure should not block the cancel itself.
      }

      return {
        ok: true,
        runId,
        previousStatus: currentStatus,
        status: updated.status,
        cancelledAt: updated.metadata?.cancellation?.cancelledAt || null,
        reason
      };
    }
  };
}

export default createAssistantRunToolHandlers;
