import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { handleConfirmAssistantToolAction, handleGetChatAgentSession, handleRouteChatAgentMessage } from '../../src/routes/chat-ui-route.js';
import chatUiConversationStore from '../../src/chat-ui/conversation-store.js';
import assistantPendingActionStore from '../../src/assistant-core/pending-action-store.js';
import chatUiConversationService from '../../src/chat-ui/conversation-service.js';
import assistantRunStore from '../../src/assistant-core/run-store.js';
import agentChannelDeliveryStore from '../../src/agent-channels/delivery-store.js';
import artifactService from '../../src/assistant-core/artifact-service.js';

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

test('handleRouteChatAgentMessage ignores stale background results from an older assistant run', async () => {
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

    await capturedBackgroundHandler({
      message: 'Qingdao weather: cloudy',
      assistantRun: {
        id: 'run-old',
        status: 'completed'
      }
    });

    assert.equal(patchCount, 1);
    assert.deepEqual(conversation.metadata.uiChatMessages, []);
    assert.equal(conversation.metadata.uiChatPendingAssistantRunId, 'run-new');
  } finally {
    chatUiConversationService.routeMessage = originalRouteMessage;
    chatUiConversationStore.findOrCreateBySessionId = originalFindOrCreateBySessionId;
    chatUiConversationStore.patch = originalPatch;
  }
});
