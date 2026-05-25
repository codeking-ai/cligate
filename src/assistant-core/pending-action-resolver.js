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
  const block = toolResults.find((entry) => isToolResultConfirmationRequired(entry));
  if (!block) {
    return null;
  }

  const normalized = normalizeAssistantToolResultEntry(block);
  if (!normalized.toolName) {
    return null;
  }

  const requestedPath = getRequestedPath(normalized);
  const summary = normalizeText(normalized.summary)
    || (requestedPath ? `Target scope: ${requestedPath}` : '');
  const runText = normalizeText(run?.triggerText);

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
      requestedPath
    }
  });
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
