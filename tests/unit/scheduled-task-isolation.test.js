import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentChannelConversationStore } from '../../src/agent-channels/conversation-store.js';
import { AgentChannelDeliveryStore } from '../../src/agent-channels/delivery-store.js';
import { StateCoordinator } from '../../src/assistant-core/domain/state-coordinator.js';
import { PersonStore } from '../../src/assistant-core/domain/person-store.js';
import { ProjectStore } from '../../src/assistant-core/domain/project-store.js';
import { TaskStore } from '../../src/assistant-core/domain/task-store.js';
import { ExecutionStore } from '../../src/assistant-core/domain/execution-store.js';
import { ScheduledTaskStore } from '../../src/assistant-core/domain/scheduled-task-store.js';
import { EpisodeLedger } from '../../src/assistant-core/domain/episode-ledger.js';
import { AgentOrchestratorMessageService } from '../../src/agent-orchestrator/message-service.js';
import { filterMainContextDeliveries } from '../../src/assistant-agent/prompt-builder.js';
import { getAssistantControlMode } from '../../src/assistant-core/assistant-state.js';
import {
  listPendingScheduledPrompts,
  selectScheduledPromptForReply
} from '../../src/agent-orchestrator/scheduled-task-prompts.js';

// Mark a task's scope conversation as having a run parked on the user, and
// register that run with a stubbed assistant-mode service so the resume bridge
// sees it as "waiting". Returns the runId.
function markScopeWaiting(conversationStore, runsById, scopeConversationId, runId, status = 'waiting_user') {
  const scope = conversationStore.get(scopeConversationId);
  conversationStore.patch(scopeConversationId, {
    metadata: {
      ...(scope?.metadata || {}),
      assistantCore: {
        ...((scope?.metadata?.assistantCore && typeof scope.metadata.assistantCore === 'object')
          ? scope.metadata.assistantCore
          : {}),
        controlMode: 'assistant',
        lastRunId: runId
      }
    }
  });
  runsById[runId] = { id: runId, status };
  return runId;
}

function installStubAssistantModeService(messageService, runsById, calls, replyFactory) {
  messageService._scheduledAssistantModeService = {
    assistantRunStore: { get: (id) => runsById[id] || null },
    async maybeHandleMessage(args) {
      calls.push(args);
      return replyFactory(args);
    }
  };
}

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createFixture() {
  const configDir = createTempDir('cligate-scheduled-isolation-');
  const conversationStore = new AgentChannelConversationStore({ configDir });
  const coordinator = new StateCoordinator({
    conversationStore,
    personStore: new PersonStore({ configDir }),
    projectStore: new ProjectStore({ configDir }),
    taskStore: new TaskStore({ configDir }),
    executionStore: new ExecutionStore({ configDir }),
    scheduledTaskStore: new ScheduledTaskStore({ configDir }),
    episodeLedger: new EpisodeLedger({ configDir })
  });
  const deliveryStore = new AgentChannelDeliveryStore({ configDir });
  const sentMessages = [];
  const deliverySender = {
    async send({ conversation, channel, payload, message }) {
      const delivery = deliveryStore.saveOutbound({
        channel: conversation?.channel || channel,
        conversationId: conversation?.id,
        sessionId: null,
        externalMessageId: '',
        status: 'sent',
        payload: { ...(payload || {}), fullText: message?.text || payload?.text || '' }
      });
      sentMessages.push({ conversation, channel, payload, message, delivery });
      return { messageId: 'delivered-' + sentMessages.length };
    },
    setRegistry() {},
    setDeliveryStore() {}
  };
  const messageService = new AgentOrchestratorMessageService({
    stateCoordinator: coordinator,
    conversationStore,
    deliverySender
  });
  return { conversationStore, coordinator, messageService, sentMessages, deliveryStore };
}

test('createScheduledTask auto-creates a dedicated scope conversation', () => {
  const { conversationStore, coordinator } = createFixture();
  const task = coordinator.createScheduledTask({
    title: '每天 PR 总结',
    kind: 'reminder',
    schedule: { recurrence: 'daily', localTime: '09:00', timezone: 'Asia/Shanghai' },
    notifyTargets: [],
    now: Date.parse('2026-05-15T00:00:00.000Z')
  });
  assert.ok(task.scopeConversationId, 'task must have a scopeConversationId');
  const scopeConv = conversationStore.get(task.scopeConversationId);
  assert.ok(scopeConv?.id, 'scope conversation must be persisted');
  assert.equal(scopeConv.channel, 'scheduled-task-scope');
  assert.equal(scopeConv.externalConversationId, task.id);
  assert.equal(scopeConv.metadata?.scheduledTaskId, task.id);
});

test('notify_user fans out to every notifyTarget with kind=scheduled_task_notification', async () => {
  const { conversationStore, coordinator, messageService, sentMessages } = createFixture();
  const convA = conversationStore.findOrCreateByExternal({
    channel: 'dingtalk', accountId: 'default',
    externalConversationId: 'ext-A', externalUserId: 'u1', title: 'A'
  });
  const convB = conversationStore.findOrCreateByExternal({
    channel: 'chat-ui', accountId: 'default',
    externalConversationId: 'ext-B', externalUserId: 'u2', title: 'B'
  });
  const task = coordinator.createScheduledTask({
    title: '吃饭啦',
    kind: 'reminder',
    schedule: { recurrence: 'once', delayMinutes: 1 },
    payload: { action: 'notify_user', message: '该吃饭了' },
    notifyTargets: [
      { kind: 'conversation', conversationId: convA.id },
      { kind: 'conversation', conversationId: convB.id }
    ]
  });

  await messageService.runScheduledTask(task);

  assert.equal(sentMessages.length, 2);
  for (const sent of sentMessages) {
    assert.equal(sent.payload.kind, 'scheduled_task_notification');
    assert.equal(sent.payload.scheduledTaskId, task.id);
    assert.match(String(sent.payload.text || ''), /该吃饭了/);
  }
  const convIds = sentMessages.map((s) => s.conversation.id).sort();
  assert.deepEqual(convIds, [convA.id, convB.id].sort());
});

test('notify_user with empty notifyTargets refuses to deliver (background-only is invalid for notify_user)', async () => {
  const { coordinator, messageService, sentMessages } = createFixture();
  const task = coordinator.createScheduledTask({
    title: 'silent reminder',
    kind: 'reminder',
    schedule: { recurrence: 'once', delayMinutes: 1 },
    payload: { action: 'notify_user', message: 'nothing' },
    notifyTargets: []
  });
  await assert.rejects(
    () => messageService.runScheduledTask(task),
    /no notifyTargets/
  );
  assert.equal(sentMessages.length, 0);
});

test('legacy payload.conversationId is auto-promoted into notifyTargets', () => {
  const { conversationStore, coordinator } = createFixture();
  const conv = conversationStore.findOrCreateByExternal({
    channel: 'dingtalk', accountId: 'default',
    externalConversationId: 'ext-legacy', externalUserId: 'u-legacy', title: 'Legacy'
  });
  const task = coordinator.createScheduledTask({
    title: 'legacy reminder',
    kind: 'reminder',
    schedule: { recurrence: 'once', delayMinutes: 1 },
    payload: { action: 'notify_user', message: 'hi', conversationId: conv.id }
    // notifyTargets not passed — backward-compat path
  });
  assert.equal(task.notifyTargets.length, 1);
  assert.equal(task.notifyTargets[0].conversationId, conv.id);
});

test('filterMainContextDeliveries excludes scheduled-task notification deliveries', () => {
  const deliveries = [
    { id: '1', direction: 'inbound', payload: { text: 'hi', kind: 'text' } },
    { id: '2', direction: 'outbound', payload: { text: 'reply', kind: 'assistant-run-result' } },
    { id: '3', direction: 'outbound', payload: { text: 'reminder', kind: 'scheduled_task_notification', scheduledTaskId: 't1' } },
    { id: '4', direction: 'outbound', payload: { text: 'old reminder', kind: 'scheduled_reminder' } },
    { id: '5', direction: 'outbound', payload: { text: 'old invoke', kind: 'scheduled_invoke_result' } },
    { id: '6', direction: 'outbound', payload: { text: 'untagged', sourceType: 'scheduled_task' } },
    { id: '7', direction: 'inbound', payload: { text: 'follow up', kind: 'text' } }
  ];
  const filtered = filterMainContextDeliveries(deliveries);
  const ids = filtered.map((d) => d.id);
  assert.deepEqual(ids, ['1', '2', '7']);
});

test('scope conversation is found and used for invoke_assistant runs (no pollution of notifyTargets)', async () => {
  // Static structural checks only — this test does NOT call runScheduledTask,
  // so it never exercises the dispatch into maybeHandleMessage. The dynamic
  // dispatch (and its past class-vs-instance crash) is covered by the next
  // test, which injects a stub assistant-mode service.
  const { conversationStore, coordinator, messageService, sentMessages } = createFixture();
  const convA = conversationStore.findOrCreateByExternal({
    channel: 'dingtalk', accountId: 'default',
    externalConversationId: 'ext-notify', externalUserId: 'u', title: 'Notify'
  });
  const task = coordinator.createScheduledTask({
    title: 'PR daily',
    kind: 'reminder',
    schedule: { recurrence: 'once', delayMinutes: 1 },
    payload: { action: 'invoke_assistant', message: 'summarize PRs' },
    notifyTargets: [{ kind: 'conversation', conversationId: convA.id }]
  });

  // Verify scope conversation exists and is distinct from notifyTarget.
  assert.ok(task.scopeConversationId);
  assert.notEqual(task.scopeConversationId, convA.id);
  const scopeConv = conversationStore.get(task.scopeConversationId);
  assert.equal(scopeConv.channel, 'scheduled-task-scope');

  // Verify notify-target fan-out logic resolves only the notifyTargets,
  // never the scope conversation.
  const resolved = messageService._resolveScheduledTaskNotifyTargets(task);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].conversationId, convA.id);
  // Specifically, the scope conversation must NOT be among delivery
  // targets — otherwise notifications would land in the scope itself.
  assert.ok(!resolved.some((t) => t.conversationId === task.scopeConversationId));
});

test('invoke_assistant dispatches into the assistant in its scope conversation (regression: class-vs-instance crash + control-mode no-op)', async () => {
  const { conversationStore, coordinator, messageService, sentMessages } = createFixture();
  const convA = conversationStore.findOrCreateByExternal({
    channel: 'dingtalk', accountId: 'default',
    externalConversationId: 'ext-invoke', externalUserId: 'u', title: 'Notify'
  });
  const task = coordinator.createScheduledTask({
    title: 'open wechat',
    kind: 'reminder',
    schedule: { recurrence: 'once', delayMinutes: 1 },
    payload: { action: 'invoke_assistant', message: '用浏览器打开微信公众号' },
    notifyTargets: [{ kind: 'conversation', conversationId: convA.id }]
  });

  // Inject a stub assistant-mode service so we drive the REAL dispatch path
  // (runScheduledTask -> invoke_assistant branch) without spinning up the LLM.
  // Before the fix, this branch called maybeHandleMessage on the CLASS default
  // export and threw "assistantModeService.maybeHandleMessage is not a function".
  const calls = [];
  messageService._scheduledAssistantModeService = {
    async maybeHandleMessage(args) {
      calls.push(args);
      return { type: 'assistant_response', message: 'opened' };
    }
  };

  const result = await messageService.runScheduledTask(task);

  // 1. Dispatch reached the assistant exactly once, with the SCOPE
  //    conversation (never the notifyTarget) and the task's message.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].conversation.id, task.scopeConversationId);
  assert.notEqual(calls[0].conversation.id, convA.id);
  assert.equal(calls[0].text, '用浏览器打开微信公众号');

  // 2. The scope conversation was promoted to assistant control mode — without
  //    this, the real maybeHandleMessage would short-circuit to null.
  const scopeConv = conversationStore.get(task.scopeConversationId);
  assert.equal(getAssistantControlMode(scopeConv), 'assistant');

  // 3. The assistant's reply is delivered to the notifyTarget as a success.
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].conversation.id, convA.id);
  assert.match(String(sentMessages[0].payload.text || ''), /opened/);

  // 4. runScheduledTask resolved without throwing and summarized the run.
  assert.match(String(result.summary || ''), /assistant invoked/);
});

test('selectScheduledPromptForReply: single resumes, ambiguous asks, title disambiguates', () => {
  assert.equal(selectScheduledPromptForReply([], '同意').match, null);

  const one = [{ scheduledTaskId: 'a', scopeConversationId: 's', title: '发文章' }];
  assert.equal(selectScheduledPromptForReply(one, '同意').match?.scheduledTaskId, 'a');

  const two = [
    { scheduledTaskId: 'a', scopeConversationId: 's1', title: '发布文章到平台' },
    { scheduledTaskId: 'b', scopeConversationId: 's2', title: '同步数据库备份' }
  ];
  // Generic affirmative with multiple waiting → ambiguous, never guess.
  const ambiguous = selectScheduledPromptForReply(two, '同意');
  assert.equal(ambiguous.match, null);
  assert.equal(ambiguous.ambiguous, true);
  // A title token in the reply disambiguates.
  assert.equal(selectScheduledPromptForReply(two, '备份那个继续').match?.scheduledTaskId, 'b');
});

test('resume bridge routes a notify-conversation reply back to the paused scope run (single waiting task)', async () => {
  const { conversationStore, coordinator, messageService } = createFixture();
  const notifyConv = conversationStore.findOrCreateByExternal({
    channel: 'dingtalk', accountId: 'default',
    externalConversationId: 'ext-notify', externalUserId: 'u1', title: '用户'
  });
  const task = coordinator.createScheduledTask({
    title: '定时发布文章',
    kind: 'reminder',
    schedule: { recurrence: 'daily', localTime: '23:25', timezone: 'Asia/Shanghai' },
    payload: { action: 'invoke_assistant', message: '发布文章' },
    notifyTargets: [{ kind: 'conversation', conversationId: notifyConv.id }],
    now: Date.parse('2026-06-03T00:00:00.000Z')
  });

  const runsById = {};
  const calls = [];
  installStubAssistantModeService(messageService, runsById, calls, () => ({
    type: 'assistant_response',
    message: '文章已发布到 CSDN / 掘金',
    assistantRun: { id: 'run-after', status: 'completed' }
  }));
  markScopeWaiting(conversationStore, runsById, task.scopeConversationId, 'run-wait-1');

  // The paused run recorded a resume binding on the notify conversation.
  messageService._syncScheduledTaskPromptBinding(task, {
    scopeConversationId: task.scopeConversationId,
    runId: 'run-wait-1',
    waiting: true
  });
  assert.equal(listPendingScheduledPrompts(conversationStore.get(notifyConv.id)).length, 1);

  const resumed = await messageService.maybeResumeScheduledTaskFromReply({
    conversation: conversationStore.get(notifyConv.id),
    text: '同意，继续发布'
  });

  // 1. The reply was driven into the SCOPE conversation, not the notify one.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].conversation.id, task.scopeConversationId);
  assert.notEqual(calls[0].conversation.id, notifyConv.id);
  assert.equal(calls[0].text, '同意，继续发布');
  // 2. The user sees the scope run's reply, tagged as a resume.
  assert.equal(resumed.type, 'scheduled_task_resumed');
  assert.match(resumed.message, /已发布|CSDN/);
  // 3. Completed run consumes the binding (no resurrection on a later reply).
  assert.equal(listPendingScheduledPrompts(conversationStore.get(notifyConv.id)).length, 0);
});

test('resume bridge asks which task when several are waiting and the reply is generic', async () => {
  const { conversationStore, coordinator, messageService } = createFixture();
  const notifyConv = conversationStore.findOrCreateByExternal({
    channel: 'dingtalk', accountId: 'default',
    externalConversationId: 'ext-notify2', externalUserId: 'u1', title: '用户'
  });
  const taskA = coordinator.createScheduledTask({
    title: '发布文章到各平台', kind: 'reminder',
    schedule: { recurrence: 'daily', localTime: '23:25', timezone: 'Asia/Shanghai' },
    payload: { action: 'invoke_assistant', message: 'x' },
    notifyTargets: [{ kind: 'conversation', conversationId: notifyConv.id }],
    now: Date.parse('2026-06-03T00:00:00.000Z')
  });
  const taskB = coordinator.createScheduledTask({
    title: '同步数据库备份', kind: 'reminder',
    schedule: { recurrence: 'daily', localTime: '23:30', timezone: 'Asia/Shanghai' },
    payload: { action: 'invoke_assistant', message: 'y' },
    notifyTargets: [{ kind: 'conversation', conversationId: notifyConv.id }],
    now: Date.parse('2026-06-03T00:00:00.000Z')
  });

  const runsById = {};
  const calls = [];
  installStubAssistantModeService(messageService, runsById, calls, () => ({
    type: 'assistant_response', message: 'done', assistantRun: { id: 'r', status: 'completed' }
  }));
  markScopeWaiting(conversationStore, runsById, taskA.scopeConversationId, 'wait-A');
  markScopeWaiting(conversationStore, runsById, taskB.scopeConversationId, 'wait-B');
  messageService._syncScheduledTaskPromptBinding(taskA, { scopeConversationId: taskA.scopeConversationId, runId: 'wait-A', waiting: true });
  messageService._syncScheduledTaskPromptBinding(taskB, { scopeConversationId: taskB.scopeConversationId, runId: 'wait-B', waiting: true });

  const resumed = await messageService.maybeResumeScheduledTaskFromReply({
    conversation: conversationStore.get(notifyConv.id),
    text: '同意'
  });

  // Never guesses — asks which task, and resumes NOTHING.
  assert.equal(resumed.type, 'scheduled_task_resume_clarify');
  assert.equal(calls.length, 0);
  assert.match(resumed.message, /发布文章到各平台/);
  assert.match(resumed.message, /同步数据库备份/);
});

test('resume bridge prunes a stale binding (scope run no longer waiting) and does not resume', async () => {
  const { conversationStore, coordinator, messageService } = createFixture();
  const notifyConv = conversationStore.findOrCreateByExternal({
    channel: 'dingtalk', accountId: 'default',
    externalConversationId: 'ext-notify3', externalUserId: 'u1', title: '用户'
  });
  const task = coordinator.createScheduledTask({
    title: '定时发布文章', kind: 'reminder',
    schedule: { recurrence: 'daily', localTime: '23:25', timezone: 'Asia/Shanghai' },
    payload: { action: 'invoke_assistant', message: 'x' },
    notifyTargets: [{ kind: 'conversation', conversationId: notifyConv.id }],
    now: Date.parse('2026-06-03T00:00:00.000Z')
  });

  const runsById = {};
  const calls = [];
  installStubAssistantModeService(messageService, runsById, calls, () => ({ type: 'assistant_response', message: 'x' }));
  // Run already completed — binding is stale.
  markScopeWaiting(conversationStore, runsById, task.scopeConversationId, 'done-1', 'completed');
  messageService._syncScheduledTaskPromptBinding(task, { scopeConversationId: task.scopeConversationId, runId: 'done-1', waiting: true });
  assert.equal(listPendingScheduledPrompts(conversationStore.get(notifyConv.id)).length, 1);

  const resumed = await messageService.maybeResumeScheduledTaskFromReply({
    conversation: conversationStore.get(notifyConv.id),
    text: '同意'
  });

  assert.equal(resumed, null);          // nothing waiting → falls through to normal routing
  assert.equal(calls.length, 0);        // never resumed a finished task
  assert.equal(listPendingScheduledPrompts(conversationStore.get(notifyConv.id)).length, 0); // pruned
});
