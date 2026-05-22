import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AssistantRunStore } from '../../src/assistant-core/run-store.js';
import createDefaultAssistantToolRegistry, { AssistantToolRegistry } from '../../src/assistant-core/tool-registry.js';
import AssistantToolExecutor from '../../src/assistant-core/tool-executor.js';
import { AssistantRunner } from '../../src/assistant-core/runner.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('AssistantRunner resumes from remaining plan steps instead of replaying completed steps', async () => {
  const runStore = new AssistantRunStore({
    configDir: createTempDir('cligate-assistant-runner-resume-')
  });
  const toolCalls = [];
  const toolRegistry = new AssistantToolRegistry();
  toolRegistry.register({
    name: 'list_tasks',
    description: 'list tasks',
    execute: async ({ input }) => {
      toolCalls.push(input?.limit || 0);
      return [];
    }
  });

  const runner = new AssistantRunner({
    runStore,
    toolRegistry,
    toolExecutor: new AssistantToolExecutor({ toolRegistry }),
    planner: {
      buildPlan() {
        return {
          summaryIntent: 'task_list',
          execution: {
            maxSteps: 3,
            maxToolCalls: 3,
            maxDurationMs: 10_000
          },
          steps: [
            { kind: 'observe', toolName: 'list_tasks', input: { limit: 1 }, reason: 'first' },
            { kind: 'observe', toolName: 'list_tasks', input: { limit: 2 }, reason: 'second' }
          ]
        };
      }
    }
  });

  const run = runStore.create({
    assistantSessionId: 'assistant-session-resume',
    conversationId: 'conversation-resume',
    triggerText: 'resume task list',
    status: 'failed',
    steps: [{
      kind: 'observe',
      status: 'completed',
      toolName: 'list_tasks',
      reason: 'first',
      summary: 'Returned 0 items'
    }],
    metadata: {
      plan: {
        summaryIntent: 'task_list',
        execution: {
          maxSteps: 3,
          maxToolCalls: 3,
          maxDurationMs: 10_000
        },
        steps: [
          { kind: 'observe', toolName: 'list_tasks', input: { limit: 1 }, reason: 'first' },
          { kind: 'observe', toolName: 'list_tasks', input: { limit: 2 }, reason: 'second' }
        ]
      },
      checkpoint: {
        resumable: true,
        completedStepCount: 1
      },
      toolResults: [{
        toolName: 'list_tasks',
        input: { limit: 1 },
        summary: 'Returned 0 items'
      }]
    }
  });

  const executed = await runner.run({
    run,
    conversation: { id: 'conversation-resume' },
    text: 'resume task list',
    resume: true
  });

  assert.deepEqual(toolCalls, [2]);
  assert.equal(executed.run.status, 'completed');
  assert.equal(executed.run.steps.length, 2);
  assert.equal(executed.run.metadata?.checkpoint?.completedStepCount, 2);
  assert.equal(executed.run.metadata?.checkpoint?.resumable, false);
});

test('assistant runtime delegation mounts active skills into delegated task input', async () => {
  const delegatedInputs = [];
  const toolRegistry = createDefaultAssistantToolRegistry({
    messageService: {
      startRuntimeTask: async ({ input }) => {
        delegatedInputs.push(String(input || ''));
        return {
          id: 'runtime-1',
          provider: 'codex',
          status: 'starting',
          title: 'delegated'
        };
      }
    },
    observationService: {
      getWorkspaceContext: () => ({}),
      listRuntimeSessions: () => [],
      getRuntimeSessionDetail: () => null,
      listConversations: () => [],
      getConversationContext: () => ({})
    },
    taskViewService: {
      getConversationTaskSpace: () => ({}),
      getTask: () => null,
      listTasks: () => []
    }
  });

  const runner = new AssistantRunner({
    runStore: new AssistantRunStore({
      configDir: createTempDir('cligate-assistant-runner-skill-mount-')
    }),
    toolRegistry,
    toolExecutor: new AssistantToolExecutor({ toolRegistry }),
    planner: {
      buildPlan() {
        return {
          summaryIntent: 'runtime_start',
          execution: {
            maxSteps: 1,
            maxToolCalls: 1,
            maxDurationMs: 10_000
          },
          steps: [
            { kind: 'act', toolName: 'delegate_to_codex', input: { task: 'Fix the bug' }, reason: 'delegate' }
          ]
        };
      }
    }
  });

  const run = {
    id: 'run-skill-mount',
    assistantSessionId: 'assistant-session',
    conversationId: 'conversation-skill',
    triggerText: 'use skill and delegate',
    status: 'queued',
    steps: [],
    metadata: {
      skills: {
        available: [],
        active: [{
          name: 'repo-investigation',
          pathToSkillMd: '/tmp/repo-investigation/SKILL.md',
          content: '1. Inspect the repo\n2. Find the bug'
        }],
        history: [{
          name: 'repo-investigation',
          pathToSkillMd: '/tmp/repo-investigation/SKILL.md'
        }]
      },
      checkpoint: {
        resumable: true,
        completedStepCount: 0,
        skills: {
          active: [{
            name: 'repo-investigation',
            pathToSkillMd: '/tmp/repo-investigation/SKILL.md',
            content: '1. Inspect the repo\n2. Find the bug'
          }],
          history: []
        }
      }
    }
  };

  await runner.run({
    run,
    conversation: { id: 'conversation-skill' },
    text: 'continue',
    resume: true
  });

  assert.equal(delegatedInputs.length, 1);
  assert.match(delegatedInputs[0], /Fix the bug/);
  assert.match(delegatedInputs[0], /<active_skills>/);
  assert.match(delegatedInputs[0], /Find the bug/);
});
