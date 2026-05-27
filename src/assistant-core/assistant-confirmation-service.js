import assistantPendingActionStore from './pending-action-store.js';
import assistantRunStore from './run-store.js';
import { ensurePendingAssistantAction } from './pending-action-resolver.js';
import createBuiltinAssistantToolRegistry, {
  AssistantToolPolicyService,
  AssistantToolsExecutor
} from '../assistant-tools/index.js';
import { resolveEnabledMcpService } from './mcp-service-resolver.js';

function normalizeText(value) {
  return String(value || '').trim();
}

function isExecutionToolPendingAction(action = {}) {
  return Boolean(
    action?.toolName
    && action?.input
    && !action?.input?.task
    && !action?.input?.message
  );
}

function resolveWorkspaceRoot(action = {}) {
  return normalizeText(
    action?.input?.cwd
      || action?.input?.path
      || action?.metadata?.requestedPath
      || process.cwd()
  ) || process.cwd();
}

function clearPendingToken(conversationStore, conversation = null) {
  if (!conversationStore?.patch || !conversation?.id) return conversation;
  return conversationStore.patch(conversation.id, {
    metadata: {
      ...(conversation.metadata || {}),
      assistantCore: {
        ...((conversation?.metadata?.assistantCore && typeof conversation.metadata.assistantCore === 'object')
          ? conversation.metadata.assistantCore
          : {}),
        pendingActionConfirmToken: null
      }
    }
  }) || conversation;
}

async function executeBuiltinPendingAction(action = {}, { mcpService = null } = {}) {
  const workspaceRoot = resolveWorkspaceRoot(action);
  const { registry, workspaceGuard } = createBuiltinAssistantToolRegistry({
    workspaceRoot,
    mcpService
  });
  const executor = new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: new AssistantToolPolicyService({
      workspaceGuard,
      allowMutatingTools: true
    })
  });
  const toolResult = await executor.executeToolCall({
    toolName: normalizeText(action.toolName),
    input: action.input || {},
    metadata: {
      approved: true
    }
  }, {
    cwd: workspaceRoot
  });
  return {
    status: toolResult?.status === 'completed' ? 'approved' : 'failed',
    decision: 'approve',
    message: normalizeText(toolResult?.content?.[0]?.text) || `Confirmed and executed ${action.toolName}.`,
    toolResult,
    pendingAction: null
  };
}

export async function resolveAssistantConfirmation({
  conversation = null,
  decision = 'approve',
  conversationStore = null,
  runStore = assistantRunStore,
  pendingActionStore = assistantPendingActionStore,
  assistantToolRegistry = null,
  assistantToolContext = {},
  mcpService = null,
  mcpServiceResolver = resolveEnabledMcpService
} = {}) {
  const normalizedDecision = normalizeText(decision).toLowerCase();
  if (!['approve', 'deny'].includes(normalizedDecision)) {
    throw new Error('decision must be approve or deny');
  }

  const action = ensurePendingAssistantAction(conversation, {
    runStore,
    pendingActionStore,
    conversationStore
  });
  if (!action) {
    return {
      kind: 'tool_error',
      error: 'No pending assistant confirmation was found for this conversation.',
      recoverable: true,
      hint: 'Only resolve assistant confirmation when the context shows a pending assistant confirmation block.'
    };
  }

  pendingActionStore.consume(action.confirmToken);
  const latestConversation = conversationStore?.get?.(conversation?.id) || conversation;
  const clearedConversation = clearPendingToken(conversationStore, latestConversation);

  if (normalizedDecision === 'deny') {
    return {
      status: 'denied',
      decision: 'deny',
      message: /[\u3400-\u9fff]/.test(normalizeText(action.title) + normalizeText(action.summary))
        ? '已取消这次待确认操作。'
        : 'Cancelled the pending confirmation action.',
      pendingAction: null,
      conversation: clearedConversation
    };
  }

  if (isExecutionToolPendingAction(action)) {
    const result = await executeBuiltinPendingAction(action, {
      mcpService: mcpService || mcpServiceResolver?.() || null
    });
    return {
      ...result,
      conversation: clearedConversation
    };
  }

  const definition = assistantToolRegistry?.get?.(action.toolName) || null;
  if (!definition?.execute) {
    return {
      kind: 'tool_error',
      error: `Pending assistant action tool is unavailable: ${action.toolName}`,
      recoverable: true,
      hint: 'The pending assistant action refers to a tool that is not currently registered.'
    };
  }

  const result = await definition.execute({
    input: action.input || {},
    context: {
      ...assistantToolContext,
      conversation: clearedConversation || latestConversation || conversation
    }
  });
  return {
    status: 'approved',
    decision: 'approve',
    message: normalizeText(result?.message || result?.summary) || `Confirmed and continued ${action.toolName}.`,
    result,
    pendingAction: null,
    conversation: clearedConversation
  };
}

export default {
  resolveAssistantConfirmation
};
