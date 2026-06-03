import assistantRunStore from './run-store.js';
import assistantPendingActionStore from './pending-action-store.js';
import { isToolResultConfirmationRequired, normalizeAssistantToolResultEntry } from '../assistant-agent/tool-result.js';

function normalizeText(value) {
  return String(value || '').trim();
}

function isAssistantConfirmationRun(run = null) {
  return String(run?.status || '').trim() === 'waiting_user'
    && String(run?.metadata?.stopPolicy?.reason || '').trim() === 'assistant_confirmation_required';
}

function getRequestedPath(normalized = {}) {
  const policy = normalized?.metadata?.policy || normalized?.policy || null;
  const writes = Array.isArray(policy?.grantedPermissions?.write)
    ? policy.grantedPermissions.write
    : [];
  return normalizeText(
    normalized?.input?.cwd
      || normalized?.input?.path
      || normalized?.input?.workspaceRef
      || normalized?.input?.workspaceId
      || normalized?.payload?.requestedPath
      || writes[0]
  );
}

function buildPendingActionFromRun(run = null, conversation = null, {
  confirmToken = '',
  pendingActionStore = assistantPendingActionStore
} = {}) {
  if (!isAssistantConfirmationRun(run)) {
    return null;
  }

  const toolResults = Array.isArray(run?.metadata?.toolResults) ? run.metadata.toolResults : [];
  // Capture EVERY tool call that the run paused on, not just the first. A single
  // supervisor turn frequently batches several mutating calls (e.g. five
  // send_message_to_channel calls to deliver five images); the old `.find()`
  // recorded only the first as the pending action, so on approval only that one
  // re-executed and the rest were silently dropped — the user kept getting the
  // same first image and the supervisor lost track of what it had sent.
  const blocks = toolResults
    .filter((entry) => isToolResultConfirmationRequired(entry))
    .map((entry) => normalizeAssistantToolResultEntry(entry))
    .filter((entry) => entry.toolName);
  if (!blocks.length) {
    return null;
  }

  const normalized = blocks[0];
  const batch = blocks.map((entry) => ({
    toolName: entry.toolName,
    input: entry.input || {}
  }));

  const requestedPath = getRequestedPath(normalized);
  const runText = normalizeText(run?.triggerText);
  const baseSummary = normalizeText(normalized.summary)
    || (requestedPath ? `Target scope: ${requestedPath}` : '');
  const summary = batch.length > 1
    ? `${batch.length} actions pending confirmation${baseSummary ? `: ${baseSummary}` : ''}`
    : baseSummary;

  return pendingActionStore.create({
    confirmToken: normalizeText(confirmToken),
    conversationId: normalizeText(conversation?.id),
    assistantRunId: normalizeText(run?.id),
    toolName: normalized.toolName,
    input: normalized.input || {},
    title: /[\u3400-\u9fff]/.test(runText)
      ? '需要确认后继续执行'
      : 'Confirmation required before continuing',
    summary,
    metadata: {
      reason: normalizeText(normalized?.payload?.reason),
      requestedPath,
      // The full set of batched tool calls this confirmation covers. Consumers
      // (assistant-confirmation-service) execute ALL of them on a single
      // approve. `toolName`/`input` above stay the first entry for back-compat.
      batch,
      batchCount: batch.length
    }
  });
}

/**
 * Expand a pending action into the list of tool invocations to execute on
 * approval. Returns the captured batch when present, otherwise the single
 * top-level tool call (back-compat). Always returns an array.
 */
export function buildPendingActionInvocations(action = {}) {
  const batch = Array.isArray(action?.metadata?.batch) ? action.metadata.batch : [];
  const normalizedBatch = batch
    .map((entry) => ({
      toolName: normalizeText(entry?.toolName),
      input: (entry?.input && typeof entry.input === 'object') ? entry.input : {}
    }))
    .filter((entry) => entry.toolName);
  if (normalizedBatch.length) {
    return normalizedBatch;
  }
  const toolName = normalizeText(action?.toolName);
  if (!toolName) return [];
  return [{
    toolName,
    input: (action?.input && typeof action.input === 'object') ? action.input : {}
  }];
}

function clearStalePendingTokenInMetadata(conversation, conversationStore) {
  const conversationId = normalizeText(conversation?.id);
  if (!conversationId || !conversationStore?.patch) {
    return;
  }
  const persistedToken = normalizeText(conversation?.metadata?.assistantCore?.pendingActionConfirmToken);
  if (!persistedToken) {
    return;
  }
  conversationStore.patch(conversationId, {
    metadata: {
      ...(conversation?.metadata || {}),
      assistantCore: {
        ...((conversation?.metadata?.assistantCore && typeof conversation.metadata.assistantCore === 'object')
          ? conversation.metadata.assistantCore
          : {}),
        pendingActionConfirmToken: null
      }
    }
  });
}

export function ensurePendingAssistantAction(conversation = null, {
  runStore = assistantRunStore,
  pendingActionStore = assistantPendingActionStore,
  conversationStore = null
} = {}) {
  const conversationId = normalizeText(conversation?.id);
  if (!conversationId) return null;

  const persistedToken = normalizeText(conversation?.metadata?.assistantCore?.pendingActionConfirmToken);
  if (persistedToken) {
    const existing = pendingActionStore.get(persistedToken);
    if (existing) {
      return existing;
    }
  }

  const latest = pendingActionStore.findLatestByConversationId(conversationId);
  if (latest) {
    return latest;
  }

  // ONLY rebuild from the most recent run. Previously this scanned the last 20
  // runs looking for any waiting_user/assistant_confirmation_required entry,
  // which meant: if the assistant ever paused on a confirmation hours ago, then
  // moved on through several completed runs, then the server restarted, a user
  // saying "继续 / 同意" would resurrect that long-dead pending action via
  // chat-ui-route's `isAffirmativeConfirmation` → `handleConfirmAssistantToolAction`
  // shortcut, executing a stale tool call AND skipping the supervisor LLM
  // entirely (so the user gets no real reply to their current question).
  //
  // The supervisor metadata's `lastRunId` is the source of truth for "is there
  // still a pending confirmation right now?". If the most recent run already
  // completed, there is no pending — clear any stale persisted token so the
  // next "继续" goes through the supervisor LLM normally.
  const preferredRunId = normalizeText(conversation?.metadata?.assistantCore?.lastRunId);
  const preferredRun = preferredRunId ? runStore.get(preferredRunId) : null;
  if (!isAssistantConfirmationRun(preferredRun)) {
    clearStalePendingTokenInMetadata(conversation, conversationStore);
    return null;
  }

  const rebuilt = buildPendingActionFromRun(preferredRun, conversation, {
    confirmToken: persistedToken,
    pendingActionStore
  });
  if (!rebuilt) {
    clearStalePendingTokenInMetadata(conversation, conversationStore);
    return null;
  }

  if (conversationStore?.patch && rebuilt.confirmToken !== persistedToken) {
    conversationStore.patch(conversationId, {
      metadata: {
        ...(conversation?.metadata || {}),
        assistantCore: {
          ...((conversation?.metadata?.assistantCore && typeof conversation.metadata.assistantCore === 'object')
            ? conversation.metadata.assistantCore
            : {}),
          pendingActionConfirmToken: rebuilt.confirmToken
        }
      }
    });
  }

  return rebuilt;
}

export default {
  ensurePendingAssistantAction
};
