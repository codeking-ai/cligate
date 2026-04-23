import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AgentRuntimeApprovalService from '../../src/agent-runtime/approval-service.js';
import { AgentRuntimeApprovalPolicyStore } from '../../src/agent-runtime/approval-policy-store.js';
import AgentRuntimeEventBus from '../../src/agent-runtime/event-bus.js';
import { AGENT_EVENT_TYPE } from '../../src/agent-runtime/models.js';
import { AgentRuntimeRegistry } from '../../src/agent-runtime/registry.js';
import { AgentRuntimeSessionManager } from '../../src/agent-runtime/session-manager.js';
import AgentRuntimeSessionStore from '../../src/agent-runtime/session-store.js';
import { AgentOrchestratorMessageService } from '../../src/agent-orchestrator/message-service.js';
import { AgentTaskStore } from '../../src/agent-core/task-store.js';
import { ChatUiConversationStore } from '../../src/chat-ui/conversation-store.js';
import { ChatUiConversationService } from '../../src/chat-ui/conversation-service.js';
import { AgentChannelDeliveryStore } from '../../src/agent-channels/delivery-store.js';
import { AssistantObservationService } from '../../src/assistant-core/observation-service.js';
import { AssistantTaskViewService } from '../../src/assistant-core/task-view-service.js';
import { AssistantRunStore } from '../../src/assistant-core/run-store.js';
import { AssistantSessionStore } from '../../src/assistant-core/session-store.js';
import AssistantModeService from '../../src/assistant-core/mode-service.js';
import AssistantDialogueService from '../../src/assistant-agent/dialogue-service.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

class FakeProvider {
  constructor() {
    this.id = 'codex';
    this.capabilities = {};
  }

  async startTurn({ input, onProviderEvent, onTurnFinished }) {
    onProviderEvent({
      type: AGENT_EVENT_TYPE.MESSAGE,
      payload: { text: `echo:${input}` }
    });
    onTurnFinished({
      status: 'ready',
      summary: `done:${input}`
    });
    return { pid: 1001 };
  }
}

function createFixture() {
  const runtimeRegistry = new AgentRuntimeRegistry();
  runtimeRegistry.register(new FakeProvider());
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry: runtimeRegistry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-assistant-react-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-assistant-react-policy-')
    })
  });
  const conversationStore = new ChatUiConversationStore({
    configDir: createTempDir('cligate-assistant-react-conv-')
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-assistant-react-task-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-assistant-react-delivery-')
  });
  const runStore = new AssistantRunStore({
    configDir: createTempDir('cligate-assistant-react-run-')
  });
  const sessionStore = new AssistantSessionStore({
    configDir: createTempDir('cligate-assistant-react-session-')
  });
  const messageService = new AgentOrchestratorMessageService({
    runtimeSessionManager
  });
  const observationService = new AssistantObservationService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    deliveryStore
  });
  const taskViewService = new AssistantTaskViewService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    deliveryStore,
    assistantRunStore: runStore
  });

  return {
    runtimeSessionManager,
    conversationStore,
    taskStore,
    deliveryStore,
    runStore,
    sessionStore,
    messageService,
    observationService,
    taskViewService
  };
}

class FakeLlmClient {
  constructor(responses = []) {
    this.responses = [...responses];
    this.calls = [];
  }

  async hasAvailableSource() {
    return true;
  }

  async complete(input) {
    this.calls.push(input);
    const next = this.responses.shift();
    if (!next) {
      throw new Error('No fake LLM response queued');
    }
    return {
      text: next.text || '',
      toolCalls: next.toolCalls || [],
      source: next.source || {
        kind: 'fake',
        label: 'fake-llm',
        model: 'fake-model'
      }
    };
  }
}

class FailingLlmClient {
  async hasAvailableSource() {
    return true;
  }

  async complete() {
    throw new Error('assistant llm failed');
  }
}

class DisabledLlmClient {
  async hasAvailableSource() {
    return false;
  }

  getFallbackReason() {
    return 'assistant_agent_disabled';
  }
}

function createAssistantService({ llmResponses }) {
  const fixture = createFixture();
  const llmClient = new FakeLlmClient(llmResponses);
  const dialogueService = new AssistantDialogueService({
    runStore: fixture.runStore,
    observationService: fixture.observationService,
    taskViewService: fixture.taskViewService,
    messageService: fixture.messageService,
    llmClient
  });
  const assistantModeService = new AssistantModeService({
    conversationStore: fixture.conversationStore,
    assistantSessionStore: fixture.sessionStore,
    assistantRunStore: fixture.runStore,
    observationService: fixture.observationService,
    messageService: fixture.messageService,
    taskViewService: fixture.taskViewService,
    dialogueService
  });
  const chatService = new ChatUiConversationService({
    conversationStore: fixture.conversationStore,
    messageService: fixture.messageService,
    taskStore: fixture.taskStore,
    assistantModeService
  });

  return {
    ...fixture,
    llmClient,
    dialogueService,
    assistantModeService,
    chatService
  };
}

function createAssistantServiceWithLlmClient(llmClient) {
  const fixture = createFixture();
  const dialogueService = new AssistantDialogueService({
    runStore: fixture.runStore,
    observationService: fixture.observationService,
    taskViewService: fixture.taskViewService,
    messageService: fixture.messageService,
    llmClient
  });
  const assistantModeService = new AssistantModeService({
    conversationStore: fixture.conversationStore,
    assistantSessionStore: fixture.sessionStore,
    assistantRunStore: fixture.runStore,
    observationService: fixture.observationService,
    messageService: fixture.messageService,
    taskViewService: fixture.taskViewService,
    dialogueService
  });
  const chatService = new ChatUiConversationService({
    conversationStore: fixture.conversationStore,
    messageService: fixture.messageService,
    taskStore: fixture.taskStore,
    assistantModeService
  });

  return {
    ...fixture,
    llmClient,
    dialogueService,
    assistantModeService,
    chatService
  };
}

test('Assistant ReAct loop can answer directly in natural language for simple /cligate chat', async () => {
  const service = createAssistantService({
    llmResponses: [{
      text: '我是 CliGate Assistant。我负责理解你的目标，必要时调用工具或委派 Codex/Claude Code 执行。'
    }]
  });

  const result = await service.chatService.routeMessage({
    sessionId: 'assistant-react-direct-1',
    text: '/cligate 你是谁'
  });

  assert.equal(result.type, 'assistant_response');
  assert.match(String(result.message || ''), /CliGate Assistant/);
  assert.equal(result.assistantRun.status, 'completed');
  assert.equal(result.assistantRun.steps[0]?.kind, 'assistant_turn');
  assert.equal(result.observability?.mode, 'agent');
  assert.equal(result.observability?.resolvedSource?.label, 'fake-llm');
  assert.equal(result.observability?.resolvedSource?.model, 'fake-model');
  assert.equal(result.observability?.stopPolicy?.closure, 'assistant_done');
});

test('Assistant ReAct loop can inspect task state through structured tool calls', async () => {
  const service = createAssistantService({
    llmResponses: [
      {
        toolCalls: [{
          id: 'tool_1',
          name: 'list_tasks',
          input: {
            limit: 1
          }
        }]
      },
      {
        text: '当前没有可见任务，所以还没有运行中的执行链路。'
      }
    ]
  });

  const result = await service.chatService.routeMessage({
    sessionId: 'assistant-react-observe-1',
    text: '/cligate 现在有哪些任务'
  });

  assert.equal(result.type, 'assistant_response');
  assert.match(String(result.message || ''), /没有可见任务/);
  assert.equal(result.assistantRun.steps[1]?.toolName, 'list_tasks');
  assert.equal(service.llmClient.calls.length, 2);
});

test('Assistant ReAct loop can delegate runtime work and return a natural-language summary', async () => {
  const service = createAssistantService({
    llmResponses: [
      {
        toolCalls: [{
          id: 'tool_delegate_1',
          name: 'delegate_to_codex',
          input: {
            task: 'inspect repo'
          }
        }]
      },
      {
        text: '我已经让 Codex 去检查仓库了。这一轮已经完成，结果显示仓库检查已跑完。'
      }
    ]
  });

  const result = await service.chatService.routeMessage({
    sessionId: 'assistant-react-delegate-1',
    text: '/cligate 帮我检查一下仓库'
  });

  assert.equal(result.type, 'assistant_response');
  assert.match(String(result.message || ''), /Codex/);
  assert.equal(result.assistantRun.status, 'completed');
  assert.equal(result.assistantRun.relatedRuntimeSessionIds.length, 1);
  assert.ok(result.assistantRun.steps.some((entry) => entry.toolName === 'delegate_to_codex'));
  assert.ok(result.assistantRun.steps.some((entry) => entry.toolName === 'summarize_runtime_result'));
});

test('Assistant dialogue fallback records the underlying LLM failure reason', async () => {
  const service = createAssistantServiceWithLlmClient(new FailingLlmClient());

  const result = await service.chatService.routeMessage({
    sessionId: 'assistant-react-fallback-1',
    text: '/cligate 你是谁'
  });

  assert.equal(result.type, 'assistant_response');
  assert.equal(result.assistantRun.metadata.assistantAgent.mode, 'fallback');
  assert.match(String(result.assistantRun.metadata.assistantAgent.reason || ''), /assistant llm failed/);
  assert.equal(result.assistantRun.metadata.plan.version, 'phase7-fallback-v1');
  assert.match(String(result.message || ''), /回退|fell back/i);
  assert.equal(result.observability?.mode, 'fallback');
  assert.match(String(result.observability?.fallbackReason || ''), /assistant llm failed/);
});

test('Assistant fallback safety rail does not guess free-form requests when the agent path is unavailable', async () => {
  const service = createAssistantServiceWithLlmClient(new DisabledLlmClient());

  const result = await service.chatService.routeMessage({
    sessionId: 'assistant-react-disabled-fallback-1',
    text: '/cligate 你是谁'
  });

  assert.equal(result.type, 'assistant_response');
  assert.equal(result.assistantRun.metadata.assistantAgent.mode, 'fallback');
  assert.equal(result.assistantRun.metadata.assistantAgent.reason, 'assistant_agent_disabled');
  assert.equal(result.assistantRun.metadata.plan.summaryIntent, 'fallback_unhandled');
  assert.match(String(result.message || ''), /当前没有可用的 LLM assistant 主路径|LLM-driven assistant path/i);
});

test('Assistant fallback safety rail still supports explicit control commands', async () => {
  const service = createAssistantServiceWithLlmClient(new DisabledLlmClient());

  const result = await service.chatService.routeMessage({
    sessionId: 'assistant-react-disabled-fallback-2',
    text: '/cligate status'
  });

  assert.equal(result.type, 'assistant_response');
  assert.notEqual(result.assistantRun.metadata.plan.summaryIntent, 'fallback_unhandled');
});

test('Assistant ReAct tool registry supports the task-and-conversation memory alias', async () => {
  const service = createAssistantService({
    llmResponses: [
      {
        toolCalls: [{
          id: 'tool_memory_1',
          name: 'search_task_and_conversation_memory',
          input: {
            query: 'inspect'
          }
        }]
      },
      {
        text: '我已经搜索了现有任务与对话摘要，目前没有更多匹配项。'
      }
    ]
  });

  const result = await service.chatService.routeMessage({
    sessionId: 'assistant-react-memory-alias-1',
    text: '/cligate 搜索一下现有任务摘要'
  });

  assert.equal(result.type, 'assistant_response');
  assert.ok(result.assistantRun.steps.some((entry) => entry.toolName === 'search_task_and_conversation_memory'));
});
