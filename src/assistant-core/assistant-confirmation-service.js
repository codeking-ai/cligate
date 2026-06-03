import assistantPendingActionStore from './pending-action-store.js';
import assistantRunStore from './run-store.js';
import { ensurePendingAssistantAction, buildPendingActionInvocations } from './pending-action-resolver.js';
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

function defaultBuiltinExecutorFactory({ workspaceRoot, mcpService } = {}) {
  const { registry, workspaceGuard } = createBuiltinAssistantToolRegistry({
    workspaceRoot,
    mcpService
  });
  return new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: new AssistantToolPolicyService({
      workspaceGuard,
      allowMutatingTools: true
    })
  });
}

async function executeBuiltinPendingAction(action = {}, {
  mcpService = null,
  conversation = null,
  executorFactory = defaultBuiltinExecutorFactory
} = {}) {
  const workspaceRoot = resolveWorkspaceRoot(action);
  const executor = executorFactory({ workspaceRoot, mcpService });

  // A single pending confirmation can cover a BATCH of tool calls (e.g. five
  // send_message_to_channel calls queued in one supervisor turn). Execute every
  // captured invocation on this one approve — historically only the first ran,
  // which silently dropped the rest. Each is guarded so one failure does not
  // abort the others.
  const invocations = buildPendingActionInvocations(action);
  const results = [];
  for (const invocation of invocations) {
    let toolResult;
    try {
      toolResult = await executor.executeToolCall({
        toolName: normalizeText(invocation.toolName),
        input: invocation.input || {},
        metadata: { approved: true }
      }, {
        cwd: workspaceRoot,
        // Pass the resolved conversation so delivery tools without an explicit
        // targetConversationId still land on the originating channel.
        conversation
      });
    } catch (error) {
      toolResult = {
        status: 'failed',
        content: [{ type: 'text', text: String(error?.message || error || 'tool execution failed') }]
      };
    }
    results.push({ toolName: invocation.toolName, toolResult });
  }

  const completedCount = results.filter((entry) => entry?.toolResult?.status === 'completed').length;
  const allCompleted = results.length > 0 && completedCount === results.length;
  const status = allCompleted ? 'approved' : (completedCount > 0 ? 'partial' : 'failed');
  const lastResult = results.length ? results[results.length - 1].toolResult : null;

  let message;
  if (results.length <= 1) {
    message = normalizeText(lastResult?.content?.[0]?.text)
      || `Confirmed and executed ${normalizeText(action.toolName) || 'the action'}.`;
  } else {
    const lines = results.map((entry, index) => {
      const text = normalizeText(entry?.toolResult?.content?.[0]?.text)
        || `${entry.toolName} ${entry?.toolResult?.status || 'finished'}`;
      return `${index + 1}. ${text}`;
    });
    message = `Confirmed and executed ${completedCount}/${results.length} actions:\n${lines.join('\n')}`;
  }

  return {
    status,
    decision: 'approve',
    message,
    toolResult: lastResult,
    toolResults: results.map((entry) => entry.toolResult),
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
  mcpServiceResolver = resolveEnabledMcpService,
  executorFactory = defaultBuiltinExecutorFactory
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
      mcpService: mcpService || mcpServiceResolver?.() || null,
      conversation: clearedConversation || latestConversation || conversation,
      executorFactory
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
