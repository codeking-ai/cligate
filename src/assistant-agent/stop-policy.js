import { ASSISTANT_RUN_CLOSURE_STATE, ASSISTANT_RUN_STATUS } from '../assistant-core/models.js';
import {
  extractToolResultSession,
  getToolResultPendingCounts,
  isToolResultConfirmationRequired,
  normalizeAssistantToolResultEntry
} from './tool-result.js';

function normalizeStatus(value) {
  return String(value || '').trim();
}

function collectSessionCandidates(toolResults = []) {
  return toolResults.map((entry) => extractToolResultSession(entry)).filter(Boolean);
}

function hasPendingContent(toolResults = []) {
  return toolResults.some((entry) => {
    const pending = getToolResultPendingCounts(entry);
    return pending.approvals > 0 || pending.questions > 0;
  });
}

function deriveWaitingReason(toolResults = []) {
  for (const entry of [...toolResults].reverse()) {
    const session = extractToolResultSession(entry);
    const normalized = normalizeAssistantToolResultEntry(entry);
    const status = normalizeStatus(session?.status || normalized.payload?.status || normalized.status);
    const pending = getToolResultPendingCounts(entry);
    const approvals = pending.approvals;
    const questions = pending.questions;
    if (status === 'waiting_approval' || approvals > 0) {
      return 'runtime_waiting_approval';
    }
    if (status === 'waiting_user' || questions > 0) {
      return 'runtime_waiting_user_input';
    }
  }
  return 'runtime_waiting_on_user';
}

function hasConfirmationBlock(toolResults = []) {
  return toolResults.some((entry) => isToolResultConfirmationRequired(entry));
}

export function deriveAssistantRunStopState({
  toolResults = [],
  assistantText = '',
  maxIterationsReached = false,
  llmFailure = null
} = {}) {
  const sessions = collectSessionCandidates(toolResults);
  const statuses = sessions.map((entry) => normalizeStatus(entry?.status));
  const hasText = Boolean(String(assistantText || '').trim());
  const hasToolResults = toolResults.length > 0;
  const pendingFound = hasPendingContent(toolResults);

  // Supervisor LLM hard-failed (all tiers errored, or turn timed out). Mark the
  // run failed up-front so the UI shows the error rather than a stale
  // "Tool X completed" status from the previous iteration's last tool result.
  if (llmFailure && llmFailure.message) {
    return {
      status: ASSISTANT_RUN_STATUS.FAILED,
      closure: ASSISTANT_RUN_CLOSURE_STATE.FAILED,
      reason: `assistant_llm_failed: ${llmFailure.message}`
    };
  }

  if (statuses.some((status) => status === 'failed')) {
    return {
      status: ASSISTANT_RUN_STATUS.FAILED,
      closure: ASSISTANT_RUN_CLOSURE_STATE.FAILED,
      reason: 'runtime_failed'
    };
  }

  if (hasConfirmationBlock(toolResults)) {
    return {
      status: ASSISTANT_RUN_STATUS.WAITING_USER,
      closure: ASSISTANT_RUN_CLOSURE_STATE.WAITING_USER,
      reason: 'assistant_confirmation_required'
    };
  }

  if (statuses.some((status) => ['waiting_user', 'waiting_approval'].includes(status)) || pendingFound) {
    return {
      status: ASSISTANT_RUN_STATUS.WAITING_USER,
      closure: ASSISTANT_RUN_CLOSURE_STATE.WAITING_USER,
      reason: deriveWaitingReason(toolResults)
    };
  }

  if (statuses.some((status) => ['starting', 'running'].includes(status))) {
    return {
      status: ASSISTANT_RUN_STATUS.WAITING_RUNTIME,
      closure: hasText
        ? ASSISTANT_RUN_CLOSURE_STATE.PARTIAL
        : ASSISTANT_RUN_CLOSURE_STATE.WAITING_RUNTIME,
      reason: hasText ? 'runtime_running_with_partial_reply' : 'runtime_running'
    };
  }

  if (maxIterationsReached && hasToolResults && !hasText) {
    return {
      status: ASSISTANT_RUN_STATUS.COMPLETED,
      closure: ASSISTANT_RUN_CLOSURE_STATE.AWAITING_SUMMARY,
      reason: 'tool_phase_finished_without_assistant_summary'
    };
  }

  if (hasToolResults && !hasText) {
    return {
      status: ASSISTANT_RUN_STATUS.COMPLETED,
      closure: ASSISTANT_RUN_CLOSURE_STATE.EXECUTOR_DONE,
      reason: 'tool_phase_finished'
    };
  }

  return {
    status: ASSISTANT_RUN_STATUS.COMPLETED,
    closure: hasText
      ? ASSISTANT_RUN_CLOSURE_STATE.ASSISTANT_DONE
      : ASSISTANT_RUN_CLOSURE_STATE.EXECUTOR_DONE,
    reason: hasText ? 'assistant_reply_completed' : 'no_follow_up_required'
  };
}

export function deriveAssistantRunStatus(input = {}) {
  return deriveAssistantRunStopState(input).status;
}

export default {
  deriveAssistantRunStatus,
  deriveAssistantRunStopState
};
