import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AssistantRunStore } from '../../src/assistant-core/run-store.js';
import {
  handleListAssistantRuns,
  handleGetAssistantRun,
  handleResumeAssistantRun
} from '../../src/routes/assistant-runs-route.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function mockRes() {
  return {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; }
  };
}

test('assistant run routes list and fetch persisted runs', async () => {
  const store = new AssistantRunStore({
    configDir: createTempDir('cligate-assistant-runs-route-')
  });
  const run = store.create({
    assistantSessionId: 'assistant-session-1',
    conversationId: 'conversation-1',
    triggerText: 'status',
    mode: 'one-shot',
    status: 'completed',
    summary: 'done',
    result: 'Workspace overview'
  });

  const singleton = (await import('../../src/assistant-core/run-store.js')).default;
  const { list, get, listByConversationId } = singleton;
  singleton.list = store.list.bind(store);
  singleton.get = store.get.bind(store);
  singleton.listByConversationId = store.listByConversationId.bind(store);

  try {
    const listRes = mockRes();
    handleListAssistantRuns({ query: { assistantSessionId: 'assistant-session-1' } }, listRes);
    assert.equal(listRes._status, 200);
    assert.equal(listRes._body.success, true);
    assert.equal(listRes._body.runs[0].id, run.id);

    const conversationListRes = mockRes();
    handleListAssistantRuns({ query: { conversationId: 'conversation-1' } }, conversationListRes);
    assert.equal(conversationListRes._body.runs[0].id, run.id);

    const detailRes = mockRes();
    handleGetAssistantRun({ params: { id: run.id } }, detailRes);
    assert.equal(detailRes._status, 200);
    assert.equal(detailRes._body.run.id, run.id);

    const missingRes = mockRes();
    handleGetAssistantRun({ params: { id: 'missing' } }, missingRes);
    assert.equal(missingRes._status, 404);
  } finally {
    singleton.list = list;
    singleton.get = get;
    singleton.listByConversationId = listByConversationId;
  }
});

test('assistant run route resumes a failed checkpointed run from remaining steps', async () => {
  const store = new AssistantRunStore({
    configDir: createTempDir('cligate-assistant-runs-resume-route-')
  });
  const run = store.create({
    assistantSessionId: 'assistant-session-2',
    conversationId: 'conversation-2',
    triggerText: 'resume task list',
    mode: 'one-shot',
    status: 'failed',
    summary: 'step failed',
    result: '',
    steps: [{
      kind: 'observe',
      status: 'completed',
      toolName: 'list_tasks',
      summary: 'Returned 0 items'
    }],
    metadata: {
      plan: {
        summaryIntent: 'task_list',
        execution: {
          maxSteps: 2,
          maxToolCalls: 2,
          maxDurationMs: 10_000
        },
        steps: [
          {
            kind: 'observe',
            toolName: 'list_tasks',
            input: { limit: 1 },
            reason: 'first'
          },
          {
            kind: 'observe',
            toolName: 'list_tasks',
            input: { limit: 1 },
            reason: 'second'
          }
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

  const singleton = (await import('../../src/assistant-core/run-store.js')).default;
  const { list, get, listByConversationId, canResume, save } = singleton;
  singleton.list = store.list.bind(store);
  singleton.get = store.get.bind(store);
  singleton.listByConversationId = store.listByConversationId.bind(store);
  singleton.canResume = store.canResume.bind(store);
  singleton.save = store.save.bind(store);

  try {
    const resumeRes = mockRes();
    await handleResumeAssistantRun({ params: { id: run.id } }, resumeRes);
    assert.equal(resumeRes._status, 200);
    assert.equal(resumeRes._body.success, true);
    assert.equal(resumeRes._body.resumed, true);
    assert.equal(resumeRes._body.run.status, 'completed');
    assert.equal(resumeRes._body.run.steps.length, 2);
    assert.equal(resumeRes._body.run.metadata?.checkpoint?.resumable, false);

    const badRes = mockRes();
    await handleResumeAssistantRun({ params: { id: 'missing' } }, badRes);
    assert.equal(badRes._status, 404);
  } finally {
    singleton.list = list;
    singleton.get = get;
    singleton.listByConversationId = listByConversationId;
    singleton.canResume = canResume;
    singleton.save = save;
  }
});
