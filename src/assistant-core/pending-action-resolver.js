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

function findFallbackRun(conversation = null, {
  runStore = assistantRunStore
} = {}) {
  const conversationId = normalizeText(conversation?.id);
  if (!conversationId) return null;
  const runs = runStore.listByConversationId(conversationId, { limit: 20 });
  return runs.find((entry) => isAssistantConfirmationRun(entry)) || null;
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

  const preferredRunId = normalizeText(conversation?.metadata?.assistantCore?.lastRunId);
  const preferredRun = preferredRunId ? runStore.get(preferredRunId) : null;
  const run = isAssistantConfirmationRun(preferredRun)
    ? preferredRun
    : findFallbackRun(conversation, { runStore });
  const rebuilt = buildPendingActionFromRun(run, conversation, {
    confirmToken: persistedToken,
    pendingActionStore
  });
  if (!rebuilt) {
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
