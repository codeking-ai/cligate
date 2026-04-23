import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AssistantRunStore } from '../../src/assistant-core/run-store.js';
import { AssistantToolRegistry } from '../../src/assistant-core/tool-registry.js';
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
