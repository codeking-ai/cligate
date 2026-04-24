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
import { SupervisorTaskStore } from '../../src/agent-orchestrator/supervisor-task-store.js';
import { TaskExecutionService } from '../../src/agent-orchestrator/task-execution-service.js';
import { AgentOrchestratorMessageService } from '../../src/agent-orchestrator/message-service.js';

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
    return { pid: 3001 };
  }
}

function createFixture() {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-task-execution-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-task-execution-policy-')
    })
  });
  const supervisorTaskStore = new SupervisorTaskStore({
    configDir: createTempDir('cligate-task-execution-supervisor-')
  });
  const taskExecutionService = new TaskExecutionService({
    runtimeSessionManager,
    supervisorTaskStore
  });
  const messageService = new AgentOrchestratorMessageService({
    runtimeSessionManager,
    supervisorTaskStore,
    taskExecutionService
  });

  return {
    runtimeSessionManager,
    supervisorTaskStore,
    taskExecutionService,
    messageService
  };
}

test('TaskExecutionService starts a fresh execution and binds it to the supervisor task', async () => {
  const { taskExecutionService, supervisorTaskStore } = createFixture();

  const session = await taskExecutionService.startTaskExecution({
    taskId: 'task-alpha',
    conversationId: 'conv-alpha',
    provider: 'codex',
    input: 'inspect repo'
  });

  const task = supervisorTaskStore.get('task-alpha');
  assert.ok(session.id);
  assert.equal(session.execution.executionId, session.id);
  assert.equal(session.execution.runtimeSessionId, session.id);
  assert.equal(session.execution.role, 'primary');
  assert.equal(task.id, 'task-alpha');
  assert.equal(task.conversationId, 'conv-alpha');
  assert.equal(task.primaryExecutionId, session.id);
  assert.ok(task.executionIds.includes(session.id));
  assert.equal(task.metadata.latestExecutionId, session.id);
  assert.equal(task.metadata.executionKind, 'runtime_session');
});

test('AgentOrchestratorMessageService continues a task through its primary execution', async () => {
  const { messageService, supervisorTaskStore, runtimeSessionManager } = createFixture();

  const started = await messageService.startRuntimeTask({
    provider: 'codex',
    input: 'initial task work',
    metadata: {
      taskId: 'task-beta',
      conversationId: 'conv-beta'
    }
  });
  supervisorTaskStore.upsertForRuntime({
    taskId: 'task-beta',
    conversationId: 'conv-beta',
    runtimeSessionId: started.id,
    provider: 'codex',
    title: 'Task beta',
    goal: 'initial task work',
    status: 'completed'
  });

  const continued = await messageService.continueRuntimeTask({
    taskId: 'task-beta',
    input: 'follow up on task beta'
  });

  const turns = runtimeSessionManager.listTurns(started.id, { limit: 10 });
  assert.equal(continued.id, started.id);
  assert.equal(continued.execution.executionId, started.id);
  assert.equal(continued.execution.runtimeSessionId, started.id);
  assert.equal(turns[0]?.input, 'follow up on task beta');
});

test('AgentOrchestratorMessageService routes natural-language continue phrasing through the task primary execution', async () => {
  const { messageService, supervisorTaskStore, runtimeSessionManager } = createFixture();

  const primary = await messageService.startRuntimeTask({
    provider: 'codex',
    input: 'initial task work',
    metadata: {
      taskId: 'task-natural-followup',
      conversationId: 'conv-natural-followup'
    }
  });

  supervisorTaskStore.upsertForRuntime({
    taskId: 'task-natural-followup',
    conversationId: 'conv-natural-followup',
    runtimeSessionId: primary.id,
    provider: 'codex',
    title: 'Natural follow-up task',
    goal: 'initial task work',
    status: 'completed'
  });

  const result = await messageService.routeUserMessage({
    message: { text: '继续刚才那个' },
    conversation: {
      id: 'conv-natural-followup',
      metadata: {
        supervisor: {
          taskMemory: {
            activeTaskId: 'task-natural-followup',
            byTask: {
              'task-natural-followup': {
                taskId: 'task-natural-followup',
                sessionId: primary.id,
                provider: 'codex',
                title: 'Natural follow-up task',
                status: 'completed'
              }
            }
          }
        }
      }
    }
  });

  const turns = runtimeSessionManager.listTurns(primary.id, { limit: 10 });
  assert.equal(result.type, 'runtime_continued');
  assert.equal(result.session.id, primary.id);
  assert.equal(turns[0]?.input, '继续刚才那个');
});

test('TaskExecutionService can add a secondary execution without overriding the primary execution', async () => {
  const { taskExecutionService, supervisorTaskStore } = createFixture();

  const primary = await taskExecutionService.startTaskExecution({
    taskId: 'task-gamma',
    conversationId: 'conv-gamma',
    provider: 'codex',
    input: 'implement feature',
    role: 'primary'
  });
  const secondary = await taskExecutionService.startTaskExecution({
    taskId: 'task-gamma',
    conversationId: 'conv-gamma',
    provider: 'codex',
    input: 'review feature',
    role: 'secondary'
  });

  const task = supervisorTaskStore.get('task-gamma');
  assert.equal(task.primaryExecutionId, primary.id);
  assert.ok(task.executionIds.includes(primary.id));
  assert.ok(task.executionIds.includes(secondary.id));
  assert.equal(task.executionIds.length, 2);
  assert.equal(secondary.execution.role, 'secondary');
  assert.equal(task.metadata.latestExecutionId, secondary.id);
});

test('AgentOrchestratorMessageService answers natural-language status through supervisor status instead of starting a new runtime', async () => {
  const { messageService } = createFixture();

  const result = await messageService.routeUserMessage({
    message: { text: '进展如何' },
    conversation: {
      metadata: {
        supervisor: {
          brief: {
            kind: 'current',
            taskId: 'task-status-1',
            title: 'Polish login page',
            provider: 'codex',
            providerLabel: 'Codex',
            status: 'running',
            summary: 'Implementing the login form polish.',
            result: '',
            error: '',
            waitingReason: '',
            nextSuggestion: 'Ask for the latest result or continue the task.'
          }
        }
      }
    }
  });

  assert.equal(result.type, 'supervisor_status');
  assert.match(String(result.message || ''), /Polish login page/);
  assert.match(String(result.message || ''), /running/i);
});

test('AgentOrchestratorMessageService returns multi-task supervisor status overview for natural-language progress queries', async () => {
  const { messageService } = createFixture();

  const result = await messageService.routeUserMessage({
    message: { text: '进展如何' },
    conversation: {
      id: 'conv-multi-status',
      metadata: {
        supervisor: {
          taskMemory: {
            activeTaskId: 'task-a',
            byTask: {
              'task-a': {
                taskId: 'task-a',
                sessionId: 'session-a',
                provider: 'codex',
                title: 'Build dashboard',
                status: 'running',
                summary: 'Implementing dashboard widgets.'
              },
              'task-b': {
                taskId: 'task-b',
                sessionId: 'session-b',
                provider: 'claude-code',
                title: 'Review API',
                status: 'waiting_user',
                pendingQuestion: 'Need database schema'
              }
            }
          }
        }
      }
    }
  });

  assert.equal(result.type, 'supervisor_status');
  assert.match(String(result.message || ''), /2 active task\(s\)/i);
  assert.match(String(result.message || ''), /Build dashboard/);
  assert.match(String(result.message || ''), /Review API/);
});

test('AgentOrchestratorMessageService chooses the current task for descriptive multi-task follow-up instead of asking for clarification', async () => {
  const { messageService, runtimeSessionManager, supervisorTaskStore } = createFixture();

  const primary = await messageService.startRuntimeTask({
    provider: 'codex',
    input: 'build dashboard',
    metadata: {
      taskId: 'task-a',
      conversationId: 'conv-smart-followup'
    }
  });
  supervisorTaskStore.upsertForRuntime({
    taskId: 'task-a',
    conversationId: 'conv-smart-followup',
    runtimeSessionId: primary.id,
    provider: 'codex',
    title: 'Build dashboard',
    goal: 'build dashboard',
    status: 'running'
  });
  supervisorTaskStore.create({
    id: 'task-b',
    conversationId: 'conv-smart-followup',
    title: 'Review API',
    goal: 'review api',
    status: 'running',
    executorStrategy: 'claude-code',
    primaryExecutionId: 'session-b',
    metadata: {
      runtimeSessionId: 'session-b',
      provider: 'claude-code'
    }
  });

  const result = await messageService.routeUserMessage({
    message: { text: '把仪表盘改成两列布局' },
    conversation: {
      id: 'conv-smart-followup',
      metadata: {
        supervisor: {
          taskMemory: {
            activeTaskId: 'task-a',
            byTask: {
              'task-a': {
                taskId: 'task-a',
                sessionId: primary.id,
                provider: 'codex',
                title: 'Build dashboard',
                status: 'running',
                summary: 'Implement dashboard widgets.'
              },
              'task-b': {
                taskId: 'task-b',
                sessionId: 'session-b',
                provider: 'claude-code',
                title: 'Review API',
                status: 'running',
                summary: 'Review authentication endpoints.'
              }
            }
          }
        }
      }
    }
  });

  const turns = runtimeSessionManager.listTurns(primary.id, { limit: 10 });
  assert.equal(result.type, 'runtime_continued');
  assert.equal(result.session.id, primary.id);
  assert.equal(turns[0]?.input, '把仪表盘改成两列布局');
});

test('AgentOrchestratorMessageService reuses remembered task identity for retry phrasing while starting a fresh execution', async () => {
  const { messageService, supervisorTaskStore } = createFixture();

  const result = await messageService.routeUserMessage({
    message: { text: '重试刚才那个' },
    conversation: {
      metadata: {
        supervisor: {
          brief: {
            kind: 'last_failed',
            taskId: 'task-retry',
            title: 'Polish login page',
            provider: 'codex',
            providerLabel: 'Codex',
            status: 'failed',
            summary: '',
            result: '',
            error: 'Write was blocked.',
            waitingReason: '',
            nextSuggestion: 'You can retry this task.'
          }
        }
      }
    },
    defaultRuntimeProvider: 'claude-code'
  });

  const task = supervisorTaskStore.get('task-retry');
  assert.equal(result.type, 'runtime_started');
  assert.equal(result.startedFresh, true);
  assert.equal(result.session.execution.taskId, 'task-retry');
  assert.equal(task.id, 'task-retry');
  assert.equal(task.metadata.originKind, 'retry_task');
  assert.match(String(result.message || ''), /Retrying remembered task/i);
});

test('AgentOrchestratorMessageService starts a related sibling task with source-task memory but fresh task identity', async () => {
  const { messageService, supervisorTaskStore } = createFixture();

  const result = await messageService.routeUserMessage({
    message: { text: '基于刚才那个再做一个：注册页' },
    conversation: {
      metadata: {
        supervisor: {
          brief: {
            kind: 'last_completed',
            taskId: 'task-source',
            title: 'Create a login page',
            provider: 'codex',
            providerLabel: 'Codex',
            status: 'completed',
            summary: 'The login page is finished.',
            result: 'index.html is ready.',
            error: '',
            waitingReason: '',
            nextSuggestion: 'You can ask for a revision, a follow-up change, or start a related task.'
          }
        }
      }
    },
    defaultRuntimeProvider: 'claude-code'
  });

  const freshTask = supervisorTaskStore.findByRuntimeSessionId(result.session.id);
  assert.equal(result.type, 'runtime_started');
  assert.equal(result.startedFresh, true);
  assert.notEqual(freshTask?.id, 'task-source');
  assert.equal(freshTask?.sourceTaskId, 'task-source');
  assert.equal(freshTask?.metadata?.originKind, 'related_sibling');
  assert.match(String(result.message || ''), /related task/i);
});

test('AgentOrchestratorMessageService chooses the non-focus active task for alternate-task phrasing', async () => {
  const { messageService, runtimeSessionManager, supervisorTaskStore } = createFixture();

  const primary = await messageService.startRuntimeTask({
    provider: 'codex',
    input: 'build qq page',
    metadata: {
      taskId: 'task-qq',
      conversationId: 'conv-alt-task'
    }
  });
  const alternate = await messageService.startRuntimeTask({
    provider: 'claude-code',
    input: 'build x page',
    metadata: {
      taskId: 'task-x',
      conversationId: 'conv-alt-task'
    }
  });

  supervisorTaskStore.upsertForRuntime({
    taskId: 'task-qq',
    conversationId: 'conv-alt-task',
    runtimeSessionId: primary.id,
    provider: 'codex',
    title: 'Build QQ page',
    goal: 'build qq page',
    status: 'completed'
  });
  supervisorTaskStore.upsertForRuntime({
    taskId: 'task-x',
    conversationId: 'conv-alt-task',
    runtimeSessionId: alternate.id,
    provider: 'claude-code',
    title: 'Build X page',
    goal: 'build x page',
    status: 'waiting_approval'
  });

  const result = await messageService.routeUserMessage({
    message: { text: '我的另外一个任务呢，执行的咋样了' },
    conversation: {
      id: 'conv-alt-task',
      metadata: {
        supervisor: {
          taskMemory: {
            activeTaskId: 'task-qq',
            byTask: {
              'task-qq': {
                taskId: 'task-qq',
                sessionId: primary.id,
                provider: 'codex',
                title: 'Build QQ page',
                status: 'completed'
              },
              'task-x': {
                taskId: 'task-x',
                sessionId: alternate.id,
                provider: 'claude-code',
                title: 'Build X page',
                status: 'waiting_approval',
                pendingApprovalTitle: 'Claude Code wants to use Write'
              }
            }
          }
        }
      }
    }
  });

  assert.equal(result.type, 'command_error');
  assert.match(String(result.message || ''), /Build X page|Claude Code/i);
  assert.match(String(result.message || ''), /permission decision|waiting on a permission decision/i);
});
