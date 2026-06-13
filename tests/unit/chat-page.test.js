import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatPageModule } from '../../public/js/modules/chat-page.js';

function createHarness(overrides = {}) {
  const localStorageState = new Map();
  const storage = overrides.localStorage || {
    getItem(key) {
      return localStorageState.has(key) ? localStorageState.get(key) : null;
    },
    setItem(key, value) {
      localStorageState.set(key, String(value));
    },
    removeItem(key) {
      localStorageState.delete(key);
    }
  };
  globalThis.localStorage = storage;
  return {
    ...createChatPageModule(),
    lang: 'en',
    activeTab: 'chat',
    chatSessions: [],
    chatStorageKey: 'cligate-chat-sessions-v1',
    t(key) {
      return key;
    },
    api: async () => ({ ok: false, data: null }),
    persistChatSessions() {},
    scrollChatToBottom() {},
    closeAgentRuntimeStream() {},
    stopAssistantRunPolling() {},
    showToast() {},
    localStorage: storage,
    ...overrides
  };
}

test('chat page counts pending items from loaded turn detail for selected task', () => {
  const app = createHarness({
    selectedChatTaskId: 'task-1',
    selectedChatTask: { id: 'task-1', pending: { approvalCount: 99, questionCount: 99 } },
    chatTaskTurnDetail: {
      pendingApprovals: [{ approvalId: 'a1' }, { approvalId: 'a2' }],
      pendingQuestions: [{ questionId: 'q1' }]
    }
  });

  assert.equal(app.currentChatTaskPendingCount(), 3);
});

test('chat page falls back to task summary data when turn detail is not selected', () => {
  const app = createHarness({
    selectedChatTaskId: 'task-1',
    selectedChatTask: { id: 'task-2', pending: { approvalCount: 2, questionCount: 1 } }
  });

  assert.equal(app.currentChatTaskPendingCount(), 3);
});

test('chat page loads tasks for active session conversation and selects first task', async () => {
  const apiCalls = [];
  const app = createHarness({
    chatSessions: [{
      id: 'chat-1',
      messages: []
    }],
    activeChatSessionId: 'chat-1',
    api: async (endpoint) => {
      apiCalls.push(endpoint);
      if (endpoint === '/api/chat/sessions/chat-1') {
        return {
          ok: true,
          data: {
            session: {
              conversationId: 'conv-1'
            }
          }
        };
      }
      if (endpoint === '/api/assistant/tasks?conversationId=conv-1&limit=8') {
        return {
          ok: true,
          data: {
            tasks: [{
              id: 'task-1',
              state: 'running',
              summary: 'Inspect repo',
              latestTurn: { id: 'turn-1' },
              runtimeSession: { id: 'runtime-1', providerLabel: 'Codex' },
              conversation: { title: 'Inspect repo' }
            }]
          }
        };
      }
      if (endpoint === '/api/assistant/tasks/task-1') {
        return {
          ok: true,
          data: {
            task: {
              id: 'task-1',
              state: 'running',
              summary: 'Inspect repo',
              latestTurn: { id: 'turn-1' },
              runtimeSession: { id: 'runtime-1', providerLabel: 'Codex' },
              conversation: { title: 'Inspect repo' }
            }
          }
        };
      }
      if (endpoint === '/api/assistant/runtime-sessions/runtime-1/turns/turn-1') {
        return {
          ok: true,
          data: {
            detail: {
              pendingApprovals: [],
              pendingQuestions: [],
              recentEvents: []
            }
          }
        };
      }
      return { ok: false, data: null };
    }
  });

  await app.loadChatTasksForActiveSession();

  assert.deepEqual(apiCalls, [
    '/api/chat/sessions/chat-1',
    '/api/assistant/tasks?conversationId=conv-1&limit=8',
    '/api/assistant/tasks/task-1',
    '/api/assistant/runtime-sessions/runtime-1/turns/turn-1'
  ]);
  assert.equal(app.chatTasks.length, 1);
  assert.equal(app.selectedChatTaskId, 'task-1');
  assert.equal(app.selectedChatTask?.id, 'task-1');
  assert.deepEqual(app.chatTaskTurnDetail?.recentEvents, []);
});

test('chat page sorts tasks by pending count and state priority', () => {
  const app = createHarness();

  const sorted = app.sortChatTasks([
    { id: 'completed', state: 'completed', updatedAt: '2026-05-15T10:00:00.000Z', pending: { approvalCount: 0, questionCount: 0 } },
    { id: 'running', state: 'running', updatedAt: '2026-05-15T09:00:00.000Z', pending: { approvalCount: 0, questionCount: 0 } },
    { id: 'waiting-user', state: 'waiting_user', updatedAt: '2026-05-15T08:00:00.000Z', pending: { approvalCount: 0, questionCount: 1 } },
    { id: 'waiting-approval', state: 'waiting_approval', updatedAt: '2026-05-15T07:00:00.000Z', pending: { approvalCount: 1, questionCount: 0 } }
  ]);

  assert.deepEqual(sorted.map((task) => task.id), [
    'waiting-approval',
    'waiting-user',
    'running',
    'completed'
  ]);
});

test('chat page limits task list and recent events for compact sidebar display', () => {
  const app = createHarness({
    chatTasks: Array.from({ length: 7 }, (_, index) => ({ id: `task-${index + 1}` })),
    chatTaskTurnDetail: {
      recentEvents: Array.from({ length: 8 }, (_, index) => ({ seq: index + 1 }))
    }
  });

  assert.equal(app.chatTaskListItems().length, 5);
  assert.equal(app.chatTaskRecentEventsLimited().length, 5);
});

test('chat page loads channel records during session bootstrap', () => {
  let channelLoadOptions = null;
  const storage = new Map([[
    'cligate-chat-sessions-v1',
    JSON.stringify([{
      id: 'chat-1',
      messages: []
    }])
  ]]);
  const app = createHarness({
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      }
    },
    loadChatChannelRecords(options = {}) {
      channelLoadOptions = options;
      return Promise.resolve();
    },
    openChatSession(sessionId) {
      this.activeChatSessionId = sessionId;
    }
  });

  app.loadChatSessions();

  assert.deepEqual(channelLoadOptions, { silent: true });
  assert.equal(app.activeChatSessionId, 'chat-1');
});

test('chat page refreshes channel records when opening the sessions panel', async () => {
  const calls = [];
  const app = createHarness({
    async loadChatChannelRecords(options = {}) {
      calls.push(['sessions', options]);
    },
    async refreshChatTaskPanel() {
      calls.push(['tasks']);
    }
  });

  await app.openChatPanel('sessions');
  await app.openChatPanel('tasks');

  assert.deepEqual(calls, [
    ['sessions', {}],
    ['tasks']
  ]);
  assert.equal(app.chatPanelOpen, true);
  assert.equal(app.chatActivePanel, 'tasks');
});

test('chat page loads channel conversations from conversation API', async () => {
  const apiCalls = [];
  const app = createHarness({
    api: async (endpoint) => {
      apiCalls.push(endpoint);
      if (endpoint === '/api/agent-channels/conversations?limit=80') {
        return {
          ok: true,
          data: {
            conversations: [{
              id: 'conv-channel-1',
              channel: 'dingtalk',
              title: 'Channel thread',
              state: 'active',
              updatedAt: '2026-05-18T10:00:00.000Z',
              lastMessagePreview: 'hello from channel',
              lastMessageDirection: 'inbound'
            }]
          }
        };
      }
      return { ok: false, data: null };
    }
  });

  await app.loadChatChannelRecords();

  assert.deepEqual(apiCalls, ['/api/agent-channels/conversations?limit=80']);
  assert.equal(app.chatChannelRecords.length, 1);
  assert.equal(app.chatRecordItems[0]?.recordType, 'channel');
  assert.equal(app.chatRecordItems[0]?.id, 'conv-channel-1');
});

test('chat page opens channel conversation detail and shows deliveries', async () => {
  const apiCalls = [];
  const app = createHarness({
    chatChannelRecords: [{
      id: 'conv-channel-1',
      channel: 'dingtalk',
      title: 'Channel thread',
      activeRuntimeSessionId: '',
      lastMessagePreview: 'hello from channel'
    }],
    api: async (endpoint) => {
      apiCalls.push(endpoint);
      if (endpoint === '/api/agent-channels/conversations/conv-channel-1') {
        return {
          ok: true,
          data: {
            conversation: {
              id: 'conv-channel-1',
              channel: 'dingtalk',
              title: 'Channel thread',
              activeRuntimeSessionId: '',
              deliveries: [{
                direction: 'inbound',
                payload: {
                  text: 'first inbound'
                },
                createdAt: '2026-05-18T10:00:00.000Z'
              }, {
                direction: 'outbound',
                payload: {
                  fullText: 'assistant reply'
                },
                createdAt: '2026-05-18T10:01:00.000Z'
              }]
            }
          }
        };
      }
      if (endpoint === '/api/assistant/tasks?conversationId=conv-channel-1&limit=8') {
        return {
          ok: true,
          data: {
            tasks: []
          }
        };
      }
      return { ok: false, data: null };
    }
  });
  app.refreshChatRecordItems();

  await app.openChannelRecord('conv-channel-1');

  assert.deepEqual(apiCalls, [
    '/api/agent-channels/conversations/conv-channel-1',
    '/api/assistant/tasks?conversationId=conv-channel-1&limit=8'
  ]);
  assert.equal(app.chatMessages.length, 2);
  assert.equal(app.chatMessages[0]?.content, 'first inbound');
  assert.equal(app.chatMessages[1]?.content, 'assistant reply');
});

test('new chat session normalizes legacy runtime mode to assistant mode', () => {
  const app = createHarness({
    chatMode: 'agent-runtime',
    chatAssistantMode: true,
    chatSourceId: 'source-1',
    chatModel: 'gpt-5.2',
    chatSources: [{ id: 'source-1', label: 'Source 1', meta: { models: ['gpt-5.2'] } }],
    openChatSession(sessionId) {
      this.activeChatSessionId = sessionId;
    }
  });

  app.newChatSession();

  assert.equal(app.chatSessions.length, 1);
  assert.equal(app.chatSessions[0].mode, 'assistant');
  assert.equal(app.chatSessions[0].assistantMode, true);
  assert.equal(app.chatAssistantMode, true);
});

test('chat page exposes direct-chat vs agent-task settings by mode', () => {
  const app = createHarness({
    chatMode: 'assistant',
    chatAssistantMode: false,
    chatSourceId: 'source-1'
  });

  assert.equal(app.showDirectChatSettings(), false);
  assert.equal(app.showAgentTaskSettings(), true);

  app.chatMode = 'direct-chat';

  assert.equal(app.showDirectChatSettings(), true);
  assert.equal(app.showAgentTaskSettings(), false);
});

test('chat page shows CliGate Assistant as the primary label for assistant-owned sessions', () => {
  const app = createHarness({
    activeChatRecord() {
      return {
        id: 'chat-1',
        recordType: 'local',
        mode: 'agent-runtime',
        assistantMode: false,
        assistantControlMode: 'assistant',
        runtimeProvider: 'codex'
      };
    },
    currentChatTask() {
      return {
        runtimeSession: { providerLabel: 'Codex' },
        summary: 'Inspect repo'
      };
    },
    chatTaskPreview() {
      return 'Inspect repo';
    }
  });

  assert.equal(app.chatInlineHeadline(), 'CliGate Assistant');
  assert.equal(app.chatSessionOriginLabel(app.activeChatRecord()), 'CliGate Assistant');
  assert.equal(app.chatInlineSummary(), 'Codex · Inspect repo');
});

test('direct chat mode is not treated as assistant-owned runtime UI', () => {
  const app = createHarness({
    chatMode: 'direct-chat',
    chatRuntimeProvider: 'codex',
    activeChatRecord() {
      return {
        id: 'chat-1',
        recordType: 'local',
        mode: 'direct-chat',
        assistantMode: false,
        runtimeProvider: 'codex'
      };
    },
    getActiveChatSession() {
      return {
        id: 'chat-1',
        runtimeSessionId: 'runtime-12345678',
        runtimeProvider: 'codex'
      };
    },
    chatSessionStatusLabel() {
      return 'agentRuntimeStatusReady';
    }
  });

  assert.equal(app.chatUsesAssistantMode(), false);
  assert.equal(app.isAssistantOwnedChatSession(app.activeChatRecord()), false);
  assert.equal(app.showDirectChatSettings(), true);
});

test('chat page keeps mode routing independent from server assistant control state', async () => {
  const app = createHarness({
    chatSessions: [{
      id: 'chat-1',
      mode: 'direct-chat',
      assistantMode: false,
      messages: []
    }],
    api: async (endpoint) => {
      if (endpoint === '/api/chat/sessions/chat-1') {
        return {
          ok: true,
          data: {
            session: {
              conversationId: 'conv-1',
              assistantState: {
                controlMode: 'assistant'
              },
              uiChatMessages: []
            }
          }
        };
      }
      return { ok: false, data: null };
    }
  });

  await app.refreshChatSessionFromServer('chat-1');

  assert.equal(app.chatSessions[0].mode, 'direct-chat');
  assert.equal(app.isAssistantOwnedChatSession(app.chatSessions[0]), false);
});

test('chat page routes by selected mode instead of legacy assistant flag', async () => {
  const calls = [];
  const app = createHarness({
    chatInput: 'inspect repo',
    chatMessages: [],
    chatAssistantMode: true,
    chatMode: 'assistant',
    activeChatSessionId: 'chat-1',
    chatSessions: [{
      id: 'chat-1',
      mode: 'assistant',
      assistantMode: true,
      runtimeProvider: 'codex',
      runtimePendingApprovals: [],
      runtimePendingQuestion: null,
      messages: [],
      updatedAt: '2026-05-18T10:00:00.000Z'
    }],
    async sendAssistantConversationMessage() {
      calls.push('assistant');
    },
    async sendAgentRuntimeMessage() {
      calls.push('runtime');
    }
  });

  await app.sendChatMessage();

  assert.deepEqual(calls, ['assistant']);
});

test('chat page settings sections follow assistant ownership instead of chatMode alone', () => {
  const app = createHarness({
    chatMode: 'assistant',
    chatAssistantMode: true
  });

  assert.equal(app.showDirectChatSettings(), false);
  assert.equal(app.showAgentTaskSettings(), true);
});

test('loadAssistantMind includes relevant artifacts and recent chat turns from conversation context', async () => {
  const apiCalls = [];
  const app = createHarness({
    activeChatSessionId: 'chat-1',
    chatSessions: [{
      id: 'chat-1',
      mode: 'assistant',
      messages: []
    }],
    api: async (endpoint) => {
      apiCalls.push(endpoint);
      if (endpoint === '/api/assistant/workspace-context') {
        return {
          ok: true,
          data: {
            knownCwds: [{ workspaceRef: 'D:\\repo' }]
          }
        };
      }
      if (endpoint === '/api/chat/sessions/chat-1') {
        return {
          ok: true,
          data: {
            session: {
              conversationId: 'conv-1'
            }
          }
        };
      }
      if (endpoint === '/api/assistant/conversations/conv-1') {
        return {
          ok: true,
          data: {
            relevantArtifacts: [{
              id: 'artifact-1',
              title: 'Patch preview',
              summary: 'Preview of the patch'
            }],
            recentChatTurns: [{
              role: 'user',
              text: 'show me the patch'
            }],
            pendingQuestions: [],
            pendingApprovals: []
          }
        };
      }
      if (endpoint === '/api/assistant/tasks?conversationId=conv-1&limit=8') {
        return {
          ok: true,
          data: {
            tasks: []
          }
        };
      }
      return { ok: false, data: null };
    }
  });

  await app.loadAssistantMind();

  assert.equal(app.assistantMind.relevantArtifacts.length, 1);
  assert.equal(app.assistantMind.recentChatTurns.length, 1);
  assert.equal(app.assistantMindArtifactPreview(app.assistantMind.relevantArtifacts[0]), 'Preview of the patch');
  assert.equal(app.assistantMindRecentTurnPreview(app.assistantMind.recentChatTurns[0]), 'show me the patch');
  assert.deepEqual(apiCalls, [
    '/api/assistant/workspace-context',
    '/api/chat/sessions/chat-1',
    '/api/assistant/conversations/conv-1',
    '/api/assistant/tasks?conversationId=conv-1&limit=8'
  ]);
});

test('direct chat sends model stream request with assistant mode disabled', async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (endpoint, options = {}) => {
    fetchCalls.push([endpoint, options]);
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));
          controller.close();
        }
      })
    };
  };

  try {
    const app = createHarness({
      chatMode: 'direct-chat',
      chatInput: 'hello',
      chatSourceId: 'source-1',
      chatModel: 'gpt-5.2',
      chatSources: [{ id: 'source-1', label: 'Source 1', meta: { models: ['gpt-5.2'] } }],
      chatSessions: [{
        id: 'chat-1',
        mode: 'direct-chat',
        sourceId: 'source-1',
        model: 'gpt-5.2',
        messages: [],
        updatedAt: '2026-05-18T10:00:00.000Z'
      }],
      activeChatSessionId: 'chat-1'
    });

    await app.sendChatMessage();

    const [endpoint, options] = fetchCalls[0];
    assert.equal(endpoint, '/api/chat/stream');
    assert.equal(JSON.parse(options.body).assistantMode, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent runtime message does not send chat model override', async () => {
  const apiCalls = [];
  const app = createHarness({
    chatMode: 'agent-runtime',
    chatInput: 'inspect repo',
    chatRuntimeProvider: 'codex',
    chatModel: 'gpt-5.4',
    chatSessions: [{
      id: 'chat-1',
      mode: 'agent-runtime',
      runtimeProvider: 'codex',
      runtimeSessionId: '',
      runtimePendingApprovals: [],
      runtimePendingQuestion: null,
      messages: [],
      updatedAt: '2026-05-18T10:00:00.000Z'
    }],
    activeChatSessionId: 'chat-1',
    api: async (endpoint, options = {}) => {
      apiCalls.push([endpoint, options]);
      return {
        ok: true,
        data: {
          result: {
            type: 'runtime_started',
            message: 'started',
            session: {
              id: 'runtime-1',
              provider: 'codex',
              model: ''
            }
          }
        }
      };
    },
    connectAgentRuntimeStream() {},
    loadAgentRuntimeSessions() {}
  });

  await app.sendAgentRuntimeMessage();

  const [, options] = apiCalls[0];
  assert.deepEqual(JSON.parse(options.body), {
    sessionId: 'chat-1',
    input: 'inspect repo',
    provider: 'codex'
  });
});

test('assistant mode message does not send direct chat model override', async () => {
  const apiCalls = [];
  const app = createHarness({
    chatMode: 'assistant',
    chatInput: 'continue in assistant',
    chatRuntimeProvider: 'claude-code',
    chatModel: 'gpt-5.4',
    activeChatSessionId: 'chat-1',
    chatSessions: [{
      id: 'chat-1',
      mode: 'assistant',
      runtimeProvider: 'claude-code',
      messages: [],
      updatedAt: '2026-05-18T10:00:00.000Z'
    }],
    api: async (endpoint, options = {}) => {
      apiCalls.push([endpoint, options]);
      return {
        ok: true,
        data: {
          result: {
            type: 'assistant_run_accepted',
            message: 'accepted',
            assistantRun: {
              id: 'run-1',
              status: 'waiting_runtime'
            },
            conversation: {
              id: 'conv-1'
            }
          }
        }
      };
    },
    pollAssistantRunUntilFinal() {}
  });

  await app.sendChatMessage();

  const [endpoint, options] = apiCalls[0];
  assert.equal(endpoint, '/api/chat/agent-message');
  assert.deepEqual(JSON.parse(options.body), {
    sessionId: 'chat-1',
    conversationId: '',
    input: 'continue in assistant',
    inputParts: [{
      type: 'text',
      text: 'continue in assistant'
    }],
    provider: 'claude-code'
  });
});

test('chat page tracks assistant run trace events separately from chat content', () => {
  const app = createHarness({
    activeChatSessionId: 'chat-1',
    chatSessions: [{
      id: 'chat-1',
      mode: 'assistant',
      pendingAssistantRunId: 'run-1',
      messages: [{
        role: 'assistant',
        kind: 'agent-status',
        content: 'accepted',
        assistantRunId: 'run-1',
        traceAnchor: true
      }]
    }]
  });
  app.chatMessages = [...app.chatSessions[0].messages];

  app.applyAssistantRunTraceEvent({
    runId: 'run-1',
    seq: 1,
    ts: '2026-05-25T10:00:00.000Z',
    type: 'assistant.tool.completed',
    phase: 'tool',
    status: 'completed',
    title: 'read_file',
    summary: 'Read file done'
  });

  assert.equal(app.chatMessages.length, 1);
  assert.equal(app.chatMessages[0].content, 'accepted');
  assert.equal(app.chatMessages[0].traceEventCount, 1);
  assert.equal(app.chatMessages[0].traceLatest.title, 'read_file');
  assert.equal(app.assistantRunTraceEvents('run-1').length, 1);
  assert.match(app.assistantRunTraceStatus('run-1'), /completed/);
});

test('chat page only shows assistant run trace on anchor messages', () => {
  const app = createHarness();

  assert.equal(app.chatMessageTraceId({
    role: 'assistant',
    kind: 'agent-status',
    assistantRunId: 'run-1',
    traceAnchor: true
  }), 'run-1');

  assert.equal(app.chatMessageTraceId({
    role: 'assistant',
    kind: 'agent-status',
    assistantRunId: 'run-1',
    traceAnchor: false
  }), '');
});

test('chat partial does not expose the assistant workbench button', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const html = readFileSync(join(process.cwd(), 'public', 'partials', 'views', 'chat.html'), 'utf8');

  assert.equal(html.includes("setActiveTab('assistantWorkbench')"), false);
});

test('chat page routes runtime execution events into a trace message', () => {
  const app = createHarness({
    activeChatSessionId: 'chat-1',
    chatSessions: [{
      id: 'chat-1',
      mode: 'agent-runtime',
      runtimeSessionId: 'runtime-1',
      messages: []
    }]
  });
  app.chatMessages = [];

  app.applyAgentRuntimeEvent('chat-1', {
    sessionId: 'runtime-1',
    turnId: 'turn-1',
    seq: 1,
    ts: '2026-05-25T10:00:00.000Z',
    type: 'worker.command',
    payload: {
      turnId: 'turn-1',
      command: 'npm test',
      output: 'ok',
      status: 'completed',
      exitCode: 0
    }
  });
  app.applyAgentRuntimeEvent('chat-1', {
    sessionId: 'runtime-1',
    turnId: 'turn-1',
    seq: 2,
    ts: '2026-05-25T10:00:01.000Z',
    type: 'worker.file_change',
    payload: {
      turnId: 'turn-1',
      changes: ['src/app.js'],
      status: 'completed'
    }
  });

  assert.equal(app.chatMessages.length, 1);
  assert.equal(app.chatMessages[0].kind, 'agent-trace');
  assert.equal(app.chatMessages[0].runtimeTraceId, 'runtime:runtime-1:turn-1');
  assert.equal(app.assistantRunTraceEvents('runtime:runtime-1:turn-1').length, 2);
  assert.equal(app.assistantRunTraceEvents('runtime:runtime-1:turn-1')[0].type, 'runtime.command');
  assert.equal(app.assistantRunTraceEvents('runtime:runtime-1:turn-1')[1].type, 'runtime.file_change');
});

test('assistant mode message can send image-only inputParts', async () => {
  const apiCalls = [];
  const app = createHarness({
    chatMode: 'assistant',
    chatInput: '',
    chatPendingImage: {
      name: 'pixel.png',
      mediaType: 'image/png',
      imageUrl: 'data:image/png;base64,abc',
      previewUrl: 'data:image/png;base64,abc'
    },
    chatRuntimeProvider: 'codex',
    activeChatSessionId: 'chat-1',
    chatSessions: [{
      id: 'chat-1',
      mode: 'assistant',
      runtimeProvider: 'codex',
      messages: [],
      updatedAt: '2026-05-18T10:00:00.000Z'
    }],
    api: async (endpoint, options = {}) => {
      apiCalls.push([endpoint, options]);
      return {
        ok: true,
        data: {
          result: {
            type: 'assistant_run_accepted',
            message: 'accepted',
            assistantRun: {
              id: 'run-2',
              status: 'waiting_runtime'
            },
            conversation: {
              id: 'conv-2'
            }
          }
        }
      };
    },
    pollAssistantRunUntilFinal() {}
  });

  await app.sendChatMessage();

  const [endpoint, options] = apiCalls[0];
  assert.equal(endpoint, '/api/chat/agent-message');
  assert.deepEqual(JSON.parse(options.body), {
    sessionId: 'chat-1',
    conversationId: '',
    input: '',
    inputParts: [{
      type: 'input_image',
      image_url: 'data:image/png;base64,abc',
      media_type: 'image/png'
    }],
    provider: 'codex'
  });
});

test('assistant mode message can send document-only inputParts', async () => {
  const apiCalls = [];
  const app = createHarness({
    chatMode: 'assistant',
    chatInput: '',
    chatPendingFile: {
      name: 'spec.pdf',
      mediaType: 'application/pdf',
      size: 1234,
      path: 'D:\\tmp\\spec.pdf'
    },
    chatRuntimeProvider: 'codex',
    activeChatSessionId: 'chat-1',
    chatSessions: [{
      id: 'chat-1',
      mode: 'assistant',
      runtimeProvider: 'codex',
      messages: [],
      updatedAt: '2026-05-18T10:00:00.000Z'
    }],
    api: async (endpoint, options = {}) => {
      apiCalls.push([endpoint, options]);
      return {
        ok: true,
        data: {
          result: {
            type: 'assistant_run_accepted',
            message: 'accepted',
            assistantRun: {
              id: 'run-3',
              status: 'waiting_runtime'
            },
            conversation: {
              id: 'conv-3'
            }
          }
        }
      };
    },
    pollAssistantRunUntilFinal() {}
  });

  await app.sendChatMessage();

  const [endpoint, options] = apiCalls[0];
  assert.equal(endpoint, '/api/chat/agent-message');
  assert.deepEqual(JSON.parse(options.body), {
    sessionId: 'chat-1',
    conversationId: '',
    input: '',
    inputParts: [{
      type: 'input_file',
      path: 'D:\\tmp\\spec.pdf',
      name: 'spec.pdf',
      media_type: 'application/pdf',
      size: 1234
    }],
    provider: 'codex'
  });
});

test('attachment picker routes images to the image handler and documents to the file handler', async () => {
  const calls = [];
  const app = createHarness({
    async handleAssistantImagePicked() { calls.push('image'); },
    async handleAssistantFilePicked() { calls.push('file'); }
  });

  // image by MIME, document by MIME, image by extension (empty MIME),
  // document by extension (empty MIME).
  await app.handleAssistantAttachmentPicked({ target: { files: [{ name: 'photo.png', type: 'image/png' }] } });
  await app.handleAssistantAttachmentPicked({ target: { files: [{ name: 'spec.pdf', type: 'application/pdf' }] } });
  await app.handleAssistantAttachmentPicked({ target: { files: [{ name: 'scan.jpg', type: '' }] } });
  await app.handleAssistantAttachmentPicked({ target: { files: [{ name: 'data.xlsx', type: '' }] } });
  // no file → no-op
  await app.handleAssistantAttachmentPicked({ target: { files: [] } });

  assert.deepEqual(calls, ['image', 'file', 'image', 'file']);
});

test('attachmentSizeLabel renders human-readable sizes (and nothing for unknown)', () => {
  const app = createHarness();
  assert.equal(app.attachmentSizeLabel(0), '');
  assert.equal(app.attachmentSizeLabel(undefined), '');
  assert.equal(app.attachmentSizeLabel(512), '512 B');
  assert.equal(app.attachmentSizeLabel(2048), '2 KB');
  assert.equal(app.attachmentSizeLabel(5 * 1024 * 1024), '5.0 MB');
});

test('legacy agent-runtime session without runtime binding normalizes to assistant mode on load', () => {
  const storage = new Map([[
    'cligate-chat-sessions-v1',
    JSON.stringify([{
      id: 'chat-1',
      mode: 'agent-runtime',
      messages: []
    }])
  ]]);
  const app = createHarness({
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      }
    },
    openChatSession(sessionId) {
      this.activeChatSessionId = sessionId;
    },
    loadChatChannelRecords() {
      return Promise.resolve();
    }
  });

  app.loadChatSessions();

  assert.equal(app.chatSessions[0].mode, 'assistant');
});

test('runtime-bound agent session remains agent-runtime after normalization', () => {
  const app = createHarness({
    chatRuntimeProvider: 'codex'
  });
  const session = {
    id: 'chat-1',
    mode: 'agent-runtime',
    runtimeSessionId: 'runtime-1',
    messages: []
  };

  app.ensureAgentRuntimeSessionDefaults(session);

  assert.equal(session.mode, 'agent-runtime');
});

test('new blank chat session preserves direct-chat mode when explicitly selected', () => {
  const app = createHarness({
    chatMode: 'direct-chat',
    chatAssistantMode: false,
    chatSourceId: 'source-1',
    chatModel: 'gpt-5.2',
    chatSources: [{ id: 'source-1', label: 'Source 1', meta: { models: ['gpt-5.2'] } }]
  });

  const session = app.buildBlankChatSession('direct-chat');

  assert.equal(session.mode, 'direct-chat');
  assert.equal(session.sourceId, 'source-1');
  assert.equal(session.model, 'gpt-5.2');
  assert.equal(session.runtimeProvider, '');
});

test('sendChatMessage uses direct chat path in direct-chat mode', async () => {
  const calls = [];
  const app = createHarness({
    chatInput: 'hello',
    chatMode: 'direct-chat',
    activeChatSessionId: 'chat-1',
    chatSessions: [{
      id: 'chat-1',
      mode: 'direct-chat',
      sourceId: 'source-1',
      model: 'gpt-5.2',
      messages: [],
      updatedAt: '2026-05-18T10:00:00.000Z'
    }],
    chatSourceId: 'source-1',
    async sendDirectChatMessage() {
      calls.push('direct');
    },
    async sendAssistantConversationMessage() {
      calls.push('assistant');
    },
    async sendAgentRuntimeMessage() {
      calls.push('runtime');
    }
  });

  await app.sendChatMessage();

  assert.deepEqual(calls, ['direct']);
});

test('runtime session config change ignores chat model differences', () => {
  const app = createHarness({
    chatRuntimeProvider: 'codex',
    chatModel: 'gpt-5.4'
  });

  const changed = app.runtimeSessionConfigChanged({
    runtimeSessionId: 'runtime-1',
    runtimeProvider: 'codex',
    attachedRuntimeProvider: 'codex',
    attachedRuntimeModel: ''
  });

  assert.equal(changed, false);
});

test('loadAgentRuntimeSessions detaches terminal runtime sessions from local chat sessions', async () => {
  const app = createHarness({
    chatSessions: [{
      id: 'chat-1',
      runtimeSessionId: 'runtime-1',
      runtimeProvider: 'codex',
      messages: [],
      updatedAt: '2026-05-18T10:00:00.000Z'
    }],
    api: async (endpoint) => {
      if (endpoint === '/api/agent-runtimes/sessions?limit=40') {
        return {
          ok: true,
          data: {
            sessions: [{
              id: 'runtime-1',
              provider: 'codex',
              status: 'failed',
              model: '',
              updatedAt: '2026-05-18T10:01:00.000Z'
            }]
          }
        };
      }
      return { ok: false, data: null };
    }
  });

  await app.loadAgentRuntimeSessions();

  assert.equal(app.chatSessions[0].runtimeStatus, 'failed');
  assert.equal(app.chatSessions[0].runtimeSessionId, '');
});
