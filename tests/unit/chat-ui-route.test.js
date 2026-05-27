import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { handleConfirmAssistantToolAction, handleGetChatAgentSession, handleRouteChatAgentMessage, hasStickyApprovalPhrase, parseAssistantPermissionCommandForTest } from '../../src/routes/chat-ui-route.js';
import chatUiConversationStore from '../../src/chat-ui/conversation-store.js';
import assistantPendingActionStore from '../../src/assistant-core/pending-action-store.js';
import chatUiConversationService from '../../src/chat-ui/conversation-service.js';
import assistantRunStore from '../../src/assistant-core/run-store.js';
import agentChannelDeliveryStore from '../../src/agent-channels/delivery-store.js';
import artifactService from '../../src/assistant-core/artifact-service.js';
import mcpConnectionManager from '../../src/mcp/index.js';

function mockRes() {
  return {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; }
  };
}

test('handleGetChatAgentSession returns persisted background assistant messages for a chat-ui session', async () => {
  const originalGetBySessionId = chatUiConversationStore.getBySessionId;
  chatUiConversationStore.getBySessionId = () => ({
    id: 'conversation-1',
    activeRuntimeSessionId: 'runtime-1',
    metadata: {
      assistantCore: {
        mode: 'assistant',
        lastRunId: 'run-1'
      },
      uiChatMessages: [{
        role: 'assistant',
        kind: 'agent-message',
        content: 'Background result arrived.',
        assistantRunId: 'run-1',
        runStatus: 'completed',
        createdAt: '2026-04-23T00:00:00.000Z'
      }]
    }
  });

  try {
    const res = mockRes();
    await handleGetChatAgentSession({ params: { sessionId: 'chat-session-1' } }, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(res._body.session.sessionId, 'chat-session-1');
    assert.equal(res._body.session.conversationId, 'conversation-1');
    assert.equal(res._body.session.activeRuntimeSessionId, 'runtime-1');
    assert.equal(res._body.session.assistantState.mode, 'assistant');
    assert.equal(res._body.session.uiChatMessages.length, 1);
    assert.equal(res._body.session.uiChatMessages[0].assistantRunId, 'run-1');
  } finally {
    chatUiConversationStore.getBySessionId = originalGetBySessionId;
  }
});

test('handleGetChatAgentSession returns 404 when the chat-ui session has no persisted conversation', async () => {
  const originalGetBySessionId = chatUiConversationStore.getBySessionId;
  chatUiConversationStore.getBySessionId = () => null;

  try {
    const res = mockRes();
    await handleGetChatAgentSession({ params: { sessionId: 'missing-session' } }, res);
    assert.equal(res._status, 404);
    assert.equal(res._body.success, false);
  } finally {
    chatUiConversationStore.getBySessionId = originalGetBySessionId;
  }
});

test('handleRouteChatAgentMessage consumes latest assistant pending action on affirmative confirmation', async () => {
  const originalGetBySessionId = chatUiConversationStore.getBySessionId;
  const originalGet = chatUiConversationStore.get;
  const originalRouteMessage = chatUiConversationService.routeMessage;

  const conversation = {
    id: 'conversation-confirm-1',
    externalConversationId: 'chat-session-confirm-1',
    metadata: {}
  };
  const pendingAction = assistantPendingActionStore.create({
    conversationId: conversation.id,
    assistantRunId: 'run-confirm-1',
    toolName: 'delegate_to_runtime',
    input: {
      provider: 'codex',
      task: '帮我查一下今天深圳的天气',
      cwd: 'D:\\github\\proxypool-hub'
    },
    title: '需要确认后继续执行',
    summary: 'Target scope: D:\\github\\proxypool-hub'
  });

  chatUiConversationStore.getBySessionId = () => conversation;
  chatUiConversationStore.get = () => conversation;
  chatUiConversationService.routeMessage = async ({ text }) => ({
    type: 'assistant_response',
    message: `continued:${text}`,
    assistantRun: {
      id: 'run-confirmed-1',
      status: 'completed'
    },
    observability: null
  });

  try {
    const res = mockRes();
    await handleRouteChatAgentMessage({
      body: {
        sessionId: 'chat-session-confirm-1',
        input: '同意',
        provider: 'codex',
        cwd: 'D:\\github\\proxypool-hub',
        model: ''
      }
    }, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(res._body.result.type, 'assistant_response');
    assert.match(String(res._body.result.message || ''), /continued:帮我查一下今天深圳的天气/);
    assert.equal(assistantPendingActionStore.get(pendingAction.confirmToken), null);
  } finally {
    chatUiConversationStore.getBySessionId = originalGetBySessionId;
    chatUiConversationStore.get = originalGet;
    chatUiConversationService.routeMessage = originalRouteMessage;
    assistantPendingActionStore.dismiss(pendingAction.confirmToken);
  }
});

test('handleConfirmAssistantToolAction replays builtin execution-tool pending actions with approval', async () => {
  const workspaceRoot = process.cwd();
  const command = process.platform === 'win32'
    ? 'echo confirmed-tool-run'
    : 'printf confirmed-tool-run';
  const pendingAction = assistantPendingActionStore.create({
    conversationId: 'conversation-exec-confirm-1',
    assistantRunId: 'run-exec-confirm-1',
    toolName: 'run_shell_command',
    input: {
      command
    },
    title: 'Confirmation required before continuing',
    summary: `Target scope: ${workspaceRoot}`,
    metadata: {
      requestedPath: workspaceRoot
    }
  });

  try {
    const res = mockRes();
    await handleConfirmAssistantToolAction({
      body: {
        confirmToken: pendingAction.confirmToken
      }
    }, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(res._body.routeResult.type, 'assistant_execution_tool_confirmed');
    assert.equal(res._body.routeResult.toolResult.status, 'completed');
    assert.match(String(res._body.routeResult.toolResult.structured?.stdout || ''), /confirmed-tool-run/i);
    assert.equal(assistantPendingActionStore.get(pendingAction.confirmToken), null);
  } finally {
    assistantPendingActionStore.dismiss(pendingAction.confirmToken);
  }
});

test('handleConfirmAssistantToolAction replays write_file pending actions using requested path as workspace root', async () => {
  const targetPath = 'D:\\tmp\\assistant-route-confirm-write.txt';
  const pendingAction = assistantPendingActionStore.create({
    conversationId: 'conversation-write-confirm-1',
    assistantRunId: 'run-write-confirm-1',
    toolName: 'write_file',
    input: {
      path: targetPath,
      content: 'hello from pending write'
    },
    title: 'Confirmation required before continuing',
    summary: `Target scope: ${targetPath}`,
    metadata: {
      requestedPath: targetPath
    }
  });

  try {
    const res = mockRes();
    await handleConfirmAssistantToolAction({
      body: {
        confirmToken: pendingAction.confirmToken
      }
    }, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(res._body.routeResult.type, 'assistant_execution_tool_confirmed');
    assert.equal(res._body.routeResult.toolResult.status, 'completed');
    assert.equal(String(res._body.routeResult.toolResult.structured?.path || ''), '.');
    assert.equal(assistantPendingActionStore.get(pendingAction.confirmToken), null);
  } finally {
    assistantPendingActionStore.dismiss(pendingAction.confirmToken);
  }
});

test('handleConfirmAssistantToolAction spawns a fresh assistant continuation run carrying the real tool result so the supervisor can finish the original multi-step task', async () => {
  // Regression: approving step 1 of "open browser → search → download → install"
  // used to stop at "Tool completed" because the approval handler only ran one
  // tool and never spawned a new ReAct turn. Verify that approving an execution
  // tool now fires a fresh async assistant run, that the run prompt carries the
  // REAL execution outcome (so the supervisor LLM doesn't think the tool is
  // still pending), and that the prompt resists the model's instinct to ask
  // for the same approval again.
  const conversationId = 'conversation-continuation-1';
  const externalConversationId = 'chat-session-continuation-1';
  const assistantRunId = 'run-continuation-1';
  const workspaceRoot = process.cwd();
  const command = process.platform === 'win32'
    ? 'echo continuation-mkdir'
    : 'printf continuation-mkdir';

  const conversation = {
    id: conversationId,
    externalConversationId,
    metadata: {
      assistantCore: {
        lastRunId: assistantRunId,
        pendingActionConfirmToken: ''
      },
      uiChatMessages: []
    }
  };

  const originalGet = chatUiConversationStore.get;
  const originalGetBySessionId = chatUiConversationStore.getBySessionId;
  const originalFindOrCreateBySessionId = chatUiConversationStore.findOrCreateBySessionId;
  const originalPatch = chatUiConversationStore.patch;
  const originalRunGet = assistantRunStore.get;
  const originalRunSave = assistantRunStore.save;
  const originalRouteMessage = chatUiConversationService.routeMessage;

  chatUiConversationStore.get = (id) => (id === conversationId ? conversation : null);
  chatUiConversationStore.getBySessionId = (id) => (id === externalConversationId ? conversation : null);
  chatUiConversationStore.findOrCreateBySessionId = (id) => (id === externalConversationId ? conversation : conversation);
  chatUiConversationStore.patch = (id, patch) => {
    conversation.metadata = {
      ...(conversation.metadata || {}),
      ...(patch?.metadata || {}),
      assistantCore: {
        ...((conversation.metadata?.assistantCore && typeof conversation.metadata.assistantCore === 'object')
          ? conversation.metadata.assistantCore
          : {}),
        ...((patch?.metadata?.assistantCore && typeof patch.metadata.assistantCore === 'object')
          ? patch.metadata.assistantCore
          : {})
      }
    };
    return conversation;
  };

  const runRecord = {
    id: assistantRunId,
    status: 'waiting_user',
    triggerText: '帮我打开浏览器,搜索飞书,进行下载后安装',
    metadata: {
      stopPolicy: {
        status: 'waiting_user',
        closure: 'waiting_user',
        reason: 'assistant_confirmation_required'
      }
    }
  };
  let currentRun = runRecord;
  assistantRunStore.get = (id) => (id === assistantRunId ? currentRun : null);
  assistantRunStore.save = (run) => { currentRun = run; return run; };

  // Capture the spawned continuation call.
  const routeCalls = [];
  chatUiConversationService.routeMessage = async (input) => {
    routeCalls.push(input);
    return {
      type: 'assistant_run_accepted',
      assistantRun: { id: 'run-continuation-spawned-1', status: 'queued' },
      conversation: { id: conversationId }
    };
  };

  const pendingAction = assistantPendingActionStore.create({
    conversationId,
    assistantRunId,
    toolName: 'run_shell_command',
    input: { command, cwd: workspaceRoot },
    title: 'Confirmation required before continuing',
    summary: `Target scope: ${workspaceRoot}`,
    metadata: { requestedPath: workspaceRoot }
  });

  try {
    const res = mockRes();
    await handleConfirmAssistantToolAction({
      body: { confirmToken: pendingAction.confirmToken }
    }, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);

    // The continuation must have been kicked off.
    // (fire-and-forget; await a microtask so the spawned call settles before
    // we read its captured arguments.)
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(routeCalls.length, 1, 'expected exactly one continuation routeMessage');

    const spawned = routeCalls[0];
    assert.equal(spawned.sessionId, externalConversationId);
    assert.equal(spawned.assistantExecutionMode, 'async');
    const prompt = String(spawned.text || '');
    // The prompt must:
    //  (a) tell the model THIS tool already ran (no second approval needed),
    //  (b) include the actual tool name so the model can re-anchor,
    //  (c) re-anchor on the user's original goal,
    //  (d) carry the real success / exitCode signal.
    assert.match(prompt, /run_shell_command/);
    assert.match(prompt, /approved by the user and has just been executed/i);
    assert.match(prompt, /Do not request approval for the same step again/i);
    assert.match(prompt, /Re-read the conversation history/i);
    assert.match(prompt, /outcome: success/i);
  } finally {
    assistantPendingActionStore.dismiss(pendingAction.confirmToken);
    chatUiConversationStore.get = originalGet;
    chatUiConversationStore.getBySessionId = originalGetBySessionId;
    chatUiConversationStore.findOrCreateBySessionId = originalFindOrCreateBySessionId;
    chatUiConversationStore.patch = originalPatch;
    assistantRunStore.get = originalRunGet;
    assistantRunStore.save = originalRunSave;
    chatUiConversationService.routeMessage = originalRouteMessage;
  }
});

test('handleConfirmAssistantToolAction marks the originating assistant run as resolved so it cannot rebuild a fresh pending action', async () => {
  // Regression: after a user clicked the approval button and the tool actually
  // ran, the underlying assistant run was left at status="waiting_user" with
  // stopPolicy.reason="assistant_confirmation_required". The next routeMessage
  // call then went through ensurePendingAssistantAction → buildPendingActionFromRun
  // and resurrected a NEW pending action from the same run, so the UI showed
  // "等待确认" again right after the approval.
  const conversationId = 'conversation-mark-resolved-1';
  const assistantRunId = 'run-mark-resolved-1';
  const workspaceRoot = process.cwd();
  const command = process.platform === 'win32'
    ? 'echo mark-resolved-confirm-tool'
    : 'printf mark-resolved-confirm-tool';

  const persistedRun = {
    id: assistantRunId,
    status: 'waiting_user',
    triggerText: 'approve please',
    metadata: {
      stopPolicy: {
        status: 'waiting_user',
        closure: 'waiting_user',
        reason: 'assistant_confirmation_required'
      },
      toolResults: [{
        toolName: 'run_shell_command',
        input: { command, cwd: workspaceRoot },
        result: {
          kind: 'policy_block',
          requiresApproval: true,
          requiresConfirmation: true,
          requestedPath: workspaceRoot
        }
      }]
    }
  };

  const originalRunGet = assistantRunStore.get;
  const originalRunSave = assistantRunStore.save;
  const originalGet = chatUiConversationStore.get;
  const originalPatch = chatUiConversationStore.patch;

  let currentRun = persistedRun;
  const savedRuns = [];
  assistantRunStore.get = (id) => (id === assistantRunId ? currentRun : null);
  assistantRunStore.save = (run) => {
    savedRuns.push(run);
    currentRun = run;
    return run;
  };

  const conversation = {
    id: conversationId,
    metadata: {
      assistantCore: {
        lastRunId: assistantRunId,
        pendingActionConfirmToken: ''
      },
      uiChatMessages: [{
        role: 'assistant',
        kind: 'agent-message',
        content: '这一步需要你确认后我才能继续。',
        assistantRunId,
        runStatus: 'waiting_user',
        pendingAction: { confirmToken: 'placeholder' }
      }]
    }
  };
  chatUiConversationStore.get = () => conversation;
  chatUiConversationStore.patch = (id, patch) => {
    conversation.metadata = {
      ...(conversation.metadata || {}),
      ...(patch?.metadata || {}),
      assistantCore: {
        ...((conversation.metadata?.assistantCore && typeof conversation.metadata.assistantCore === 'object')
          ? conversation.metadata.assistantCore
          : {}),
        ...((patch?.metadata?.assistantCore && typeof patch.metadata.assistantCore === 'object')
          ? patch.metadata.assistantCore
          : {})
      },
      ...(Array.isArray(patch?.metadata?.uiChatMessages) ? { uiChatMessages: patch.metadata.uiChatMessages } : {})
    };
    return conversation;
  };

  const pendingAction = assistantPendingActionStore.create({
    conversationId,
    assistantRunId,
    toolName: 'run_shell_command',
    input: { command, cwd: workspaceRoot },
    title: 'Confirmation required before continuing',
    summary: `Target scope: ${workspaceRoot}`,
    metadata: { requestedPath: workspaceRoot }
  });

  try {
    const res = mockRes();
    await handleConfirmAssistantToolAction({
      body: { confirmToken: pendingAction.confirmToken }
    }, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);

    // The originating run must be moved out of waiting_user so the next
    // routeMessage call does NOT resurrect a fresh pending action.
    assert.equal(currentRun.status, 'completed');
    assert.equal(currentRun.metadata.stopPolicy.reason, 'assistant_confirmation_resolved');
    assert.equal(currentRun.metadata.stopPolicy.status, 'completed');
    assert.equal(currentRun.metadata.confirmationResolution.decision, 'approve');
    assert.equal(currentRun.metadata.confirmationResolution.toolName, 'run_shell_command');

    // The conversation summary must move past "等待确认" so the UI does not
    // keep showing it.
    assert.notEqual(conversation.metadata.assistantCore.lastRunSummary, '等待确认');
    assert.ok(conversation.metadata.assistantCore.lastRunResolvedAt);

    // And the pending action store must not be re-populated for this run.
    assert.equal(assistantPendingActionStore.findLatestByConversationId(conversationId), null);
  } finally {
    assistantRunStore.get = originalRunGet;
    assistantRunStore.save = originalRunSave;
    chatUiConversationStore.get = originalGet;
    chatUiConversationStore.patch = originalPatch;
    assistantPendingActionStore.dismiss(pendingAction.confirmToken);
  }
});

test('handleRouteChatAgentMessage records pending assistant run id for async chat-ui runs', async () => {
  const originalRouteMessage = chatUiConversationService.routeMessage;
  const originalGet = chatUiConversationStore.get;
  const originalFindOrCreateBySessionId = chatUiConversationStore.findOrCreateBySessionId;
  const originalPatch = chatUiConversationStore.patch;

  const patches = [];
  const conversation = {
    id: 'conversation-pending-run-1',
    metadata: {
      uiChatMessages: []
    }
  };

  chatUiConversationService.routeMessage = async () => ({
    type: 'assistant_run_accepted',
    assistantRun: {
      id: 'run-pending-1',
      status: 'waiting_runtime'
    },
    conversation: {
      id: conversation.id
    }
  });
  chatUiConversationStore.get = () => conversation;
  chatUiConversationStore.findOrCreateBySessionId = () => conversation;
  chatUiConversationStore.patch = (conversationId, patch) => {
    patches.push({ conversationId, patch });
    conversation.metadata = {
      ...(conversation.metadata || {}),
      ...(patch.metadata || {})
    };
    return conversation;
  };

  try {
    const res = mockRes();
    await handleRouteChatAgentMessage({
      body: {
        sessionId: 'chat-session-pending-run-1',
        input: '/cligate weather sanya',
        provider: 'codex',
        cwd: '',
        model: ''
      }
    }, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(conversation.metadata.uiChatPendingAssistantRunId, 'run-pending-1');
    assert.ok(patches.some((entry) => entry.patch?.metadata?.uiChatPendingAssistantRunId === 'run-pending-1'));
  } finally {
    chatUiConversationService.routeMessage = originalRouteMessage;
    chatUiConversationStore.get = originalGet;
    chatUiConversationStore.findOrCreateBySessionId = originalFindOrCreateBySessionId;
    chatUiConversationStore.patch = originalPatch;
  }
});

test('handleRouteChatAgentMessage persists chat-ui assistant turns into delivery history', async () => {
  const originalRouteMessage = chatUiConversationService.routeMessage;
  const originalGetBySessionId = chatUiConversationStore.getBySessionId;
  const originalFindOrCreateBySessionId = chatUiConversationStore.findOrCreateBySessionId;
  const originalSaveInbound = agentChannelDeliveryStore.saveInbound;
  const originalSaveOutbound = agentChannelDeliveryStore.saveOutbound;

  const savedInbound = [];
  const savedOutbound = [];
  const conversation = {
    id: 'conversation-delivery-history-1',
    activeRuntimeSessionId: 'runtime-history-1',
    metadata: {}
  };

  chatUiConversationStore.getBySessionId = () => conversation;
  chatUiConversationStore.findOrCreateBySessionId = () => conversation;
  agentChannelDeliveryStore.saveInbound = (record) => {
    savedInbound.push(record);
    return record;
  };
  agentChannelDeliveryStore.saveOutbound = (record) => {
    savedOutbound.push(record);
    return record;
  };
  chatUiConversationService.routeMessage = async () => ({
    type: 'assistant_response',
    message: '你刚才问了一个问题，我已经回答了。',
    assistantRun: {
      id: 'run-history-1',
      status: 'completed'
    },
    conversation
  });

  try {
    const res = mockRes();
    await handleRouteChatAgentMessage({
      body: {
        sessionId: 'chat-session-history-1',
        input: '我刚才问了几个问题？',
        provider: 'codex',
        cwd: '',
        model: ''
      }
    }, res);

    assert.equal(res._status, 200);
    assert.equal(savedInbound.length, 1);
    assert.equal(savedInbound[0].channel, 'chat-ui');
    assert.equal(savedInbound[0].conversationId, conversation.id);
    assert.equal(savedInbound[0].payload.text, '我刚才问了几个问题？');
    assert.equal(savedOutbound.length, 1);
    assert.equal(savedOutbound[0].payload.text, '你刚才问了一个问题，我已经回答了。');
    assert.equal(savedOutbound[0].payload.assistantRunId, 'run-history-1');
  } finally {
    chatUiConversationService.routeMessage = originalRouteMessage;
    chatUiConversationStore.getBySessionId = originalGetBySessionId;
    chatUiConversationStore.findOrCreateBySessionId = originalFindOrCreateBySessionId;
    agentChannelDeliveryStore.saveInbound = originalSaveInbound;
    agentChannelDeliveryStore.saveOutbound = originalSaveOutbound;
  }
});

test('handleRouteChatAgentMessage persists structured image inputParts into inbound delivery history', async () => {
  const originalRouteMessage = chatUiConversationService.routeMessage;
  const originalGetBySessionId = chatUiConversationStore.getBySessionId;
  const originalFindOrCreateBySessionId = chatUiConversationStore.findOrCreateBySessionId;
  const originalSaveInbound = agentChannelDeliveryStore.saveInbound;
  const originalCreateArtifact = artifactService.createArtifact;

  const savedInbound = [];
  const createdArtifacts = [];
  const conversation = {
    id: 'conversation-delivery-image-history-1',
    activeRuntimeSessionId: 'runtime-image-history-1',
    metadata: {}
  };

  chatUiConversationStore.getBySessionId = () => conversation;
  chatUiConversationStore.findOrCreateBySessionId = () => conversation;
  agentChannelDeliveryStore.saveInbound = (record) => {
    savedInbound.push(record);
    return record;
  };
  artifactService.createArtifact = (payload) => {
    const artifact = { id: 'artifact-image-1', ...payload };
    createdArtifacts.push(artifact);
    return artifact;
  };
  chatUiConversationService.routeMessage = async () => ({
    type: 'assistant_response',
    message: '收到图片了。',
    assistantRun: {
      id: 'run-image-history-1',
      status: 'completed'
    },
    conversation
  });

  try {
    const res = mockRes();
    await handleRouteChatAgentMessage({
      body: {
        sessionId: 'chat-session-image-history-1',
        input: '',
        inputParts: [{
          type: 'input_image',
          image_url: 'data:image/png;base64,abc',
          media_type: 'image/png'
        }],
        provider: 'codex'
      }
    }, res);

    assert.equal(res._status, 200);
    assert.equal(savedInbound.length, 1);
    assert.equal(savedInbound[0].payload.text, '[image attachment]');
    assert.deepEqual(savedInbound[0].payload.inputParts, [{
      type: 'input_image',
      image_url: 'data:image/png;base64,abc',
      media_type: 'image/png'
    }]);
    assert.equal(createdArtifacts.length, 1);
    assert.deepEqual(savedInbound[0].payload.artifactRefs, ['artifact-image-1']);
  } finally {
    chatUiConversationService.routeMessage = originalRouteMessage;
    chatUiConversationStore.getBySessionId = originalGetBySessionId;
    chatUiConversationStore.findOrCreateBySessionId = originalFindOrCreateBySessionId;
    agentChannelDeliveryStore.saveInbound = originalSaveInbound;
    artifactService.createArtifact = originalCreateArtifact;
  }
});

test('handleRouteChatAgentMessage accepts structured inputParts for assistant image input', async () => {
  const originalRouteMessage = chatUiConversationService.routeMessage;
  const originalGetBySessionId = chatUiConversationStore.getBySessionId;
  const originalFindOrCreateBySessionId = chatUiConversationStore.findOrCreateBySessionId;

  const conversation = {
    id: 'conversation-image-input-1',
    activeRuntimeSessionId: 'runtime-image-1',
    metadata: {}
  };
  let capturedPayload = null;

  chatUiConversationStore.getBySessionId = () => conversation;
  chatUiConversationStore.findOrCreateBySessionId = () => conversation;
  chatUiConversationService.routeMessage = async (payload) => {
    capturedPayload = payload;
    return {
      type: 'assistant_response',
      message: '收到图片了。',
      assistantRun: {
        id: 'run-image-1',
        status: 'completed'
      },
      conversation
    };
  };

  try {
    const res = mockRes();
    await handleRouteChatAgentMessage({
      body: {
        sessionId: 'chat-session-image-1',
        input: '',
        inputParts: [{
          type: 'input_image',
          image_url: 'data:image/png;base64,abc'
        }],
        provider: 'codex'
      }
    }, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(capturedPayload?.text, '');
    assert.deepEqual(capturedPayload?.inputParts, [{
      type: 'input_image',
      image_url: 'data:image/png;base64,abc'
    }]);
  } finally {
    chatUiConversationService.routeMessage = originalRouteMessage;
    chatUiConversationStore.getBySessionId = originalGetBySessionId;
    chatUiConversationStore.findOrCreateBySessionId = originalFindOrCreateBySessionId;
  }
});

test('handleRouteChatAgentMessage rebuilds pending action from persisted waiting-user run after restart-style loss', async () => {
  const originalGetBySessionId = chatUiConversationStore.getBySessionId;
  const originalGet = chatUiConversationStore.get;
  const originalRunGet = assistantRunStore.get;
  const originalRouteMessage = chatUiConversationService.routeMessage;

  const conversation = {
    id: 'conversation-rebuild-1',
    externalConversationId: 'chat-session-rebuild-1',
    metadata: {
      assistantCore: {
        lastRunId: 'run-waiting-1'
      }
    }
  };

  chatUiConversationStore.getBySessionId = () => conversation;
  chatUiConversationStore.get = () => conversation;
  assistantRunStore.get = () => ({
    id: 'run-waiting-1',
    status: 'waiting_user',
    triggerText: '请继续',
    metadata: {
      toolResults: [{
        toolName: 'write_file',
        input: {
          path: 'D:\\tmp\\rebuilt.txt',
          content: 'rebuilt'
        },
        result: {
          kind: 'policy_block',
          requiresApproval: true,
          requiresConfirmation: true,
          requestedPath: 'D:\\tmp\\rebuilt.txt'
        }
      }]
    }
  });
  chatUiConversationService.routeMessage = async ({ text }) => ({
    type: 'assistant_response',
    message: `continued:${text}`,
    assistantRun: {
      id: 'run-confirmed-rebuild-1',
      status: 'completed'
    }
  });

  try {
    const res = mockRes();
    await handleRouteChatAgentMessage({
      body: {
        sessionId: 'chat-session-rebuild-1',
        input: '同意，继续进行',
        provider: 'codex',
        cwd: '',
        model: ''
      }
    }, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.match(String(res._body.result.message || ''), /continued:/);
  } finally {
    chatUiConversationStore.getBySessionId = originalGetBySessionId;
    chatUiConversationStore.get = originalGet;
    assistantRunStore.get = originalRunGet;
    chatUiConversationService.routeMessage = originalRouteMessage;
  }
});

test('handleRouteChatAgentMessage falls back to default workspace root when cwd is empty', async () => {
  const originalRouteMessage = chatUiConversationService.routeMessage;
  const originalEnv = process.env.CLIGATE_DEFAULT_CHAT_UI_WORKSPACE;
  process.env.CLIGATE_DEFAULT_CHAT_UI_WORKSPACE = 'D:\\tmp';

  let capturedCwd = null;
  chatUiConversationService.routeMessage = async ({ cwd }) => {
    capturedCwd = cwd;
    return {
      type: 'assistant_response',
      message: 'ok',
      assistantRun: {
        id: 'run-default-cwd-1',
        status: 'completed'
      }
    };
  };

  try {
    const res = mockRes();
    await handleRouteChatAgentMessage({
      body: {
        sessionId: 'chat-session-default-cwd-1',
        input: 'hello',
        provider: 'codex',
        cwd: '',
        model: ''
      }
    }, res);

    assert.equal(res._status, 200);
    assert.equal(capturedCwd, 'D:\\tmp');
  } finally {
    if (originalEnv === undefined) {
      delete process.env.CLIGATE_DEFAULT_CHAT_UI_WORKSPACE;
    } else {
      process.env.CLIGATE_DEFAULT_CHAT_UI_WORKSPACE = originalEnv;
    }
    chatUiConversationService.routeMessage = originalRouteMessage;
  }
});

test('handleRouteChatAgentMessage persists late background results from an older assistant run alongside the newer pending run', async () => {
  // Regression: when the user fires off a follow-up message while the first
  // run is still executing, the original guard `pendingRunId === backgroundRunId`
  // dropped run-A's reply on the floor. The chat then showed only the trace
  // anchor ("已经在后台处理…") and the final answer was visible only inside the
  // expanded execution-trace panel — exactly the bug a user reported as
  // "all replies got swallowed by the execution process, no separate final
  // reply block". The new behavior persists run-A's reply AND keeps run-new
  // as the pending pointer so the newer run can finalize the same way.
  const originalRouteMessage = chatUiConversationService.routeMessage;
  const originalFindOrCreateBySessionId = chatUiConversationStore.findOrCreateBySessionId;
  const originalPatch = chatUiConversationStore.patch;

  let capturedBackgroundHandler = null;
  let patchCount = 0;
  const conversation = {
    id: 'conversation-stale-background-1',
    metadata: {
      uiChatPendingAssistantRunId: 'run-new',
      uiChatMessages: []
    }
  };

  chatUiConversationService.routeMessage = async ({ onBackgroundResult }) => {
    capturedBackgroundHandler = onBackgroundResult;
    return {
      type: 'assistant_run_accepted',
      assistantRun: {
        id: 'run-new',
        status: 'waiting_runtime'
      },
      conversation: {
        id: conversation.id
      }
    };
  };
  chatUiConversationStore.findOrCreateBySessionId = () => conversation;
  chatUiConversationStore.patch = (_conversationId, patch) => {
    patchCount += 1;
    conversation.metadata = {
      ...(conversation.metadata || {}),
      ...(patch.metadata || {})
    };
    return conversation;
  };

  try {
    const res = mockRes();
    await handleRouteChatAgentMessage({
      body: {
        sessionId: 'chat-session-stale-background-1',
        input: '/cligate weather sanya',
        provider: 'codex',
        cwd: '',
        model: ''
      }
    }, res);

    assert.equal(typeof capturedBackgroundHandler, 'function');
    const patchCountAfterRoute = patchCount;

    await capturedBackgroundHandler({
      message: 'Qingdao weather: cloudy',
      assistantRun: {
        id: 'run-old',
        status: 'completed'
      }
    });

    assert.equal(patchCount, patchCountAfterRoute + 1);
    assert.equal(conversation.metadata.uiChatMessages.length, 1);
    assert.equal(conversation.metadata.uiChatMessages[0].assistantRunId, 'run-old');
    assert.equal(conversation.metadata.uiChatMessages[0].runStatus, 'completed');
    assert.equal(conversation.metadata.uiChatMessages[0].content, 'Qingdao weather: cloudy');
    // run-new is still pending; do NOT clobber its pointer with run-old's terminal status.
    assert.equal(conversation.metadata.uiChatPendingAssistantRunId, 'run-new');

    // Re-firing the same stale result must be idempotent (dedup via hasPersistedUiAssistantMessage).
    await capturedBackgroundHandler({
      message: 'Qingdao weather: cloudy',
      assistantRun: {
        id: 'run-old',
        status: 'completed'
      }
    });
    assert.equal(conversation.metadata.uiChatMessages.length, 1);
  } finally {
    chatUiConversationService.routeMessage = originalRouteMessage;
    chatUiConversationStore.findOrCreateBySessionId = originalFindOrCreateBySessionId;
    chatUiConversationStore.patch = originalPatch;
  }
});

test('hasStickyApprovalPhrase matches the natural ways users grant blanket approval', () => {
  // Real phrases captured from conv 76fb84e0 — these MUST flip yolo on, otherwise
  // the user gets stuck in an approval loop again.
  const shouldEnable = [
    '确认，继续进行，后续所有操作都完全同意，不用再问我了',
    '确认，进行后续操作，任何操作都同意',
    '开始执行吧，不要每一步都问我，直接执行',
    '我完全同意，同意后续所有操作，不要再问我了，直接同意',
    '本次对话都允许',
    '本次对话都允许读取该 skill 文件',
    '一律同意',
    '后续都同意',
    'yolo',
    'auto-approve',
    'approve all',
    "don't ask me again",
    'from now on always approve'
  ];
  for (const phrase of shouldEnable) {
    assert.equal(hasStickyApprovalPhrase(phrase), true, `expected sticky-approval HIT for: ${phrase}`);
  }
});

test('handleConfirmAssistantToolAction clears persisted conversation pending state for builtin execution-tool confirmations', async () => {
  const workspaceRoot = process.cwd();
  const command = process.platform === 'win32'
    ? 'echo confirmed-tool-run'
    : 'printf confirmed-tool-run';
  const conversationId = 'conversation-exec-confirm-persisted-1';
  const pendingAction = assistantPendingActionStore.create({
    conversationId,
    assistantRunId: 'run-exec-confirm-persisted-1',
    toolName: 'run_shell_command',
    input: {
      command
    },
    title: 'Confirmation required before continuing',
    summary: `Target scope: ${workspaceRoot}`,
    metadata: {
      requestedPath: workspaceRoot
    }
  });

  const originalGet = chatUiConversationStore.get;
  const originalPatch = chatUiConversationStore.patch;
  const conversation = {
    id: conversationId,
    metadata: {
      assistantCore: {
        pendingActionConfirmToken: pendingAction.confirmToken
      },
      uiChatMessages: [{
        role: 'assistant',
        pendingAction: {
          confirmToken: pendingAction.confirmToken
        }
      }]
    }
  };

  chatUiConversationStore.get = (id) => (id === conversationId ? conversation : null);
  chatUiConversationStore.patch = (id, patch) => {
    if (id !== conversationId) return conversation;
    conversation.metadata = {
      ...(conversation.metadata || {}),
      ...(patch.metadata || {})
    };
    return conversation;
  };

  try {
    const res = mockRes();
    await handleConfirmAssistantToolAction({
      body: {
        confirmToken: pendingAction.confirmToken
      }
    }, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(conversation.metadata.assistantCore.pendingActionConfirmToken, null);
    assert.equal(conversation.metadata.uiChatMessages[0].pendingAction, null);
  } finally {
    chatUiConversationStore.get = originalGet;
    chatUiConversationStore.patch = originalPatch;
    assistantPendingActionStore.dismiss(pendingAction.confirmToken);
  }
});

test('handleConfirmAssistantToolAction replays approved direct MCP tool confirmations with mounted MCP tools', async () => {
  const conversationId = 'conversation-mcp-direct-confirm-1';
  const pendingAction = assistantPendingActionStore.create({
    conversationId,
    assistantRunId: 'run-mcp-direct-confirm-1',
    toolName: 'mcp__docs__search',
    input: {
      query: 'approved direct call'
    },
    title: 'Confirmation required before continuing',
    summary: 'MCP tool requires approval'
  });

  const conversation = {
    id: conversationId,
    metadata: {
      assistantCore: {
        pendingActionConfirmToken: pendingAction.confirmToken
      },
      uiChatMessages: [{
        role: 'assistant',
        pendingAction: {
          confirmToken: pendingAction.confirmToken
        }
      }]
    }
  };
  const calls = [];

  const originalGet = chatUiConversationStore.get;
  const originalPatch = chatUiConversationStore.patch;
  const originalHasEnabledServers = mcpConnectionManager.hasEnabledServers;
  const originalListServers = mcpConnectionManager.listServers;
  const originalListTools = mcpConnectionManager.listTools;
  const originalCallTool = mcpConnectionManager.callTool;

  chatUiConversationStore.get = (id) => (id === conversationId ? conversation : null);
  chatUiConversationStore.patch = (id, patch) => {
    if (id !== conversationId) return conversation;
    conversation.metadata = {
      ...(conversation.metadata || {}),
      ...(patch.metadata || {})
    };
    return conversation;
  };
  mcpConnectionManager.hasEnabledServers = () => true;
  mcpConnectionManager.listServers = () => [{ name: 'docs' }];
  mcpConnectionManager.listTools = ({ serverName } = {}) => {
    assert.equal(serverName, 'docs');
    return [{
      serverName: 'docs',
      toolName: 'search',
      namespacedToolName: 'mcp__docs__search',
      description: 'Search docs',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      }
    }];
  };
  mcpConnectionManager.callTool = async ({ serverName, toolName, arguments: args }) => {
    calls.push({ serverName, toolName, args });
    return {
      content: [{
        type: 'text',
        text: `called:${toolName}:${args.query}`
      }]
    };
  };

  try {
    const res = mockRes();
    await handleConfirmAssistantToolAction({
      body: {
        confirmToken: pendingAction.confirmToken
      }
    }, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.deepEqual(calls, [{
      serverName: 'docs',
      toolName: 'search',
      args: { query: 'approved direct call' }
    }]);
    assert.equal(res._body.routeResult.toolResult.status, 'completed');
    assert.equal(res._body.routeResult.toolResult.structured.namespacedToolName, 'mcp__docs__search');
    assert.equal(conversation.metadata.assistantCore.pendingActionConfirmToken, null);
    assert.equal(conversation.metadata.uiChatMessages[0].pendingAction, null);
  } finally {
    chatUiConversationStore.get = originalGet;
    chatUiConversationStore.patch = originalPatch;
    mcpConnectionManager.hasEnabledServers = originalHasEnabledServers;
    mcpConnectionManager.listServers = originalListServers;
    mcpConnectionManager.listTools = originalListTools;
    mcpConnectionManager.callTool = originalCallTool;
    assistantPendingActionStore.dismiss(pendingAction.confirmToken);
  }
});

test('hasStickyApprovalPhrase does NOT trip on single-shot or unrelated phrasing', () => {
  // Single-word affirmations should stay one-shot.
  const shouldStayOneShot = ['同意', '继续', '确认', '可以', '好', '行', 'ok', 'yes'];
  for (const phrase of shouldStayOneShot) {
    assert.equal(hasStickyApprovalPhrase(phrase), false, `unexpected sticky-approval HIT for one-shot: ${phrase}`);
  }
  // Unrelated chatter.
  const unrelated = [
    '你在执行生成ppt的任务吗',
    '帮我查看图片',
    '开始执行', // "start" alone isn't a yolo signal
    '现在还在执行吗'
  ];
  for (const phrase of unrelated) {
    assert.equal(hasStickyApprovalPhrase(phrase), false, `unexpected sticky-approval HIT for unrelated: ${phrase}`);
  }
  // Explicit denials must NEVER flip yolo on even when sticky tokens leak through.
  const denials = ['我不同意', '我不同意所有这些', '拒绝', '取消那个操作', 'do not approve', 'reject'];
  for (const phrase of denials) {
    assert.equal(hasStickyApprovalPhrase(phrase), false, `sticky-approval DENY guard failed on: ${phrase}`);
  }
});

test('parseAssistantPermissionCommand recognizes /yolo and /safe slash commands', () => {
  assert.deepEqual(parseAssistantPermissionCommandForTest('/yolo'), { command: 'yolo' });
  assert.deepEqual(parseAssistantPermissionCommandForTest('/auto-approve'), { command: 'yolo' });
  assert.deepEqual(parseAssistantPermissionCommandForTest('/dangerously-skip-permissions'), { command: 'yolo' });
  assert.deepEqual(parseAssistantPermissionCommandForTest('/safe'), { command: 'safe' });
  assert.deepEqual(parseAssistantPermissionCommandForTest('/stop-yolo'), { command: 'safe' });
  assert.equal(parseAssistantPermissionCommandForTest('/cligate'), null);
  assert.equal(parseAssistantPermissionCommandForTest(''), null);
  assert.equal(parseAssistantPermissionCommandForTest('not a command'), null);
});

test('handleRouteChatAgentMessage does NOT throw on sticky-approval phrase (regression: const reassignment)', async () => {
  // Regression for conv 618e00b5: a sticky-approval phrase made the route
  // throw `TypeError: Assignment to constant variable.` because `conversation`
  // was declared `const`. The user saw zero downstream runs and only a 500
  // toast, even though autoApproveTools=true had silently been persisted.
  const originalGetBySessionId = chatUiConversationStore.getBySessionId;
  const originalGet = chatUiConversationStore.get;
  const originalPatch = chatUiConversationStore.patch;
  const originalRouteMessage = chatUiConversationService.routeMessage;
  const originalFindOrCreateBySessionId = chatUiConversationStore.findOrCreateBySessionId;

  let conversation = {
    id: 'conversation-sticky-regression-1',
    externalConversationId: 'chat-session-sticky-regression-1',
    metadata: { assistantCore: {} }
  };
  const patches = [];

  chatUiConversationStore.getBySessionId = () => conversation;
  chatUiConversationStore.get = () => conversation;
  chatUiConversationStore.findOrCreateBySessionId = () => conversation;
  chatUiConversationStore.patch = (id, patch) => {
    patches.push(patch);
    conversation = {
      ...conversation,
      metadata: {
        ...(conversation.metadata || {}),
        ...(patch.metadata || {})
      }
    };
    return conversation;
  };

  let routeMessageCalled = false;
  let routeMessageInput = null;
  chatUiConversationService.routeMessage = async (args) => {
    routeMessageCalled = true;
    routeMessageInput = args;
    return {
      type: 'assistant_run_accepted',
      message: 'started',
      assistantRun: { id: 'run-sticky-regression-1', status: 'queued' },
      conversation: { id: conversation.id },
      observability: null
    };
  };

  try {
    const res = mockRes();
    await handleRouteChatAgentMessage({
      body: {
        sessionId: 'chat-session-sticky-regression-1',
        input: '确认，后续所有操作都同意',
        provider: 'codex',
        cwd: '',
        model: ''
      }
    }, res);

    // Bug 1: must NOT crash. Before the fix, this returned 500 with
    // "Assignment to constant variable." and routeMessage was never called.
    assert.equal(res._status, 200, `expected 200, got ${res._status}: ${JSON.stringify(res._body)}`);
    assert.equal(res._body.success, true);
    assert.equal(routeMessageCalled, true, 'routeMessage must be invoked once the const regression is fixed');
    assert.equal(routeMessageInput?.text, '确认，后续所有操作都同意');
    assert.equal(conversation.metadata.assistantCore.autoApproveTools, true, 'sticky-approval phrase must persist autoApproveTools=true');
  } finally {
    chatUiConversationStore.getBySessionId = originalGetBySessionId;
    chatUiConversationStore.get = originalGet;
    chatUiConversationStore.patch = originalPatch;
    chatUiConversationStore.findOrCreateBySessionId = originalFindOrCreateBySessionId;
    chatUiConversationService.routeMessage = originalRouteMessage;
  }
});

test('AgentChannelConversationStore.patch shallow-merges metadata so concurrent writers cannot lose sibling keys', async () => {
  const { AgentChannelConversationStore } = await import('../../src/agent-channels/conversation-store.js');
  const tmpDir = (await import('node:fs/promises')).mkdtemp;
  const path = await import('node:path');
  const os = await import('node:os');
  const dir = await tmpDir(path.join(os.tmpdir(), 'cligate-conv-store-merge-'));

  const store = new AgentChannelConversationStore({ configDir: dir });
  const created = store.save({
    id: 'conv-merge-1',
    channel: 'chat-ui',
    accountId: 'default',
    externalConversationId: 'merge-1',
    externalUserId: 'local-user',
    metadata: {
      assistantCore: { mode: 'assistant', lastRunId: 'A' },
      uiChatPendingAssistantRunId: 'run-A',
      ui: { origin: 'chat-ui' }
    }
  });
  assert.equal(created.metadata.uiChatPendingAssistantRunId, 'run-A');

  // Simulate a stale writer (mode-service finalizeRunSuccess) that only knows
  // about assistantCore — it must NOT wipe uiChatPendingAssistantRunId from
  // the freshly-set state.
  const stalePatch = store.patch('conv-merge-1', {
    metadata: {
      // intentionally omitting uiChatPendingAssistantRunId
      assistantCore: { mode: 'assistant', lastRunId: 'B' }
    }
  });

  assert.equal(stalePatch.metadata.assistantCore.lastRunId, 'B');
  assert.equal(stalePatch.metadata.uiChatPendingAssistantRunId, 'run-A', 'must NOT be clobbered by a stale concurrent patch');
  assert.equal(stalePatch.metadata.ui?.origin, 'chat-ui', 'sibling keys must survive');
});
