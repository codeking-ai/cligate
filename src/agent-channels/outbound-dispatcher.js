import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import { AGENT_EVENT_TYPE } from '../agent-runtime/models.js';
import { buildSupervisorBrief } from '../agent-orchestrator/supervisor-brief.js';
import agentChannelConversationStore from './conversation-store.js';
import agentChannelDeliveryStore from './delivery-store.js';
import { formatAgentRuntimeEventForChannel } from './formatter.js';
import agentChannelRegistry from './registry.js';

const NOTIFIABLE_EVENT_TYPES = new Set([
  AGENT_EVENT_TYPE.STARTED,
  AGENT_EVENT_TYPE.APPROVAL_REQUEST,
  AGENT_EVENT_TYPE.QUESTION,
  AGENT_EVENT_TYPE.COMPLETED,
  AGENT_EVENT_TYPE.FAILED
]);

export class AgentChannelOutboundDispatcher {
  constructor({
    runtimeSessionManager = agentRuntimeSessionManager,
    conversationStore = agentChannelConversationStore,
    deliveryStore = agentChannelDeliveryStore,
    registry = agentChannelRegistry
  } = {}) {
    this.runtimeSessionManager = runtimeSessionManager;
    this.conversationStore = conversationStore;
    this.deliveryStore = deliveryStore;
    this.registry = registry;
    this.unsubscribe = null;
  }

  start() {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.runtimeSessionManager.eventBus.subscribeAll((event) => {
      this.handleRuntimeEvent(event).catch(() => {});
    });
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  buildConversationSupervisorPatch({ conversation, session, event }) {
    const metadata = {
      ...(conversation?.metadata || {})
    };
    const supervisor = {
      ...((metadata.supervisor && typeof metadata.supervisor === 'object') ? metadata.supervisor : {})
    };
    const taskMemory = {
      ...((supervisor.taskMemory && typeof supervisor.taskMemory === 'object') ? supervisor.taskMemory : {})
    };

    if (event?.type === AGENT_EVENT_TYPE.STARTED) {
      taskMemory.current = {
        sessionId: session?.id || event?.sessionId || null,
        provider: session?.provider || '',
        title: session?.title || event?.payload?.title || '',
        status: 'running',
        startedAt: event?.ts || new Date().toISOString(),
        lastUpdateAt: event?.ts || new Date().toISOString(),
        summary: '',
        result: ''
      };
    }

    if (event?.type === AGENT_EVENT_TYPE.APPROVAL_REQUEST && taskMemory.current) {
      taskMemory.current.status = 'waiting_approval';
      taskMemory.current.lastUpdateAt = event?.ts || new Date().toISOString();
      taskMemory.current.pendingApprovalTitle = event?.payload?.title || '';
    }

    if (event?.type === AGENT_EVENT_TYPE.QUESTION && taskMemory.current) {
      taskMemory.current.status = 'waiting_user';
      taskMemory.current.lastUpdateAt = event?.ts || new Date().toISOString();
      taskMemory.current.pendingQuestion = event?.payload?.text || '';
    }

    if (event?.type === AGENT_EVENT_TYPE.COMPLETED && taskMemory.current) {
      taskMemory.current.status = 'completed';
      taskMemory.current.lastUpdateAt = event?.ts || new Date().toISOString();
      taskMemory.current.summary = String(session?.summary || event?.payload?.summary || '').trim();
      taskMemory.current.result = String(event?.payload?.result || '').trim();
      taskMemory.lastCompleted = {
        sessionId: taskMemory.current.sessionId,
        provider: taskMemory.current.provider,
        title: taskMemory.current.title,
        completedAt: event?.ts || new Date().toISOString(),
        summary: taskMemory.current.summary,
        result: taskMemory.current.result
      };
    }

    if (event?.type === AGENT_EVENT_TYPE.FAILED && taskMemory.current) {
      taskMemory.current.status = 'failed';
      taskMemory.current.lastUpdateAt = event?.ts || new Date().toISOString();
      taskMemory.current.error = String(event?.payload?.message || session?.error || '').trim();
      taskMemory.lastFailed = {
        sessionId: taskMemory.current.sessionId,
        provider: taskMemory.current.provider,
        title: taskMemory.current.title,
        failedAt: event?.ts || new Date().toISOString(),
        error: taskMemory.current.error
      };
    }

    supervisor.taskMemory = taskMemory;
    supervisor.brief = buildSupervisorBrief({ taskMemory, session });
    metadata.supervisor = supervisor;
    return { metadata };
  }

  async handleRuntimeEvent(event) {
    if (!NOTIFIABLE_EVENT_TYPES.has(event?.type)) {
      return;
    }

    const conversations = this.conversationStore.listByRuntimeSessionId(event.sessionId);
    if (conversations.length === 0) {
      return;
    }

    const session = this.runtimeSessionManager.getSession(event.sessionId);
    for (const conversation of conversations) {
      const provider = this.registry.get(conversation.channel);
      if (!provider?.sendMessage) {
        continue;
      }

      const formatted = formatAgentRuntimeEventForChannel({ event, session });
      if (!formatted?.text) {
        continue;
      }

      try {
        const result = await provider.sendMessage({
          conversation,
          text: formatted.text,
          buttons: formatted.buttons || [],
          session,
          event
        });

        this.deliveryStore.saveOutbound({
          channel: conversation.channel,
          conversationId: conversation.id,
          sessionId: event.sessionId,
          eventSeq: event.seq,
          externalMessageId: result?.messageId || '',
          status: 'sent',
          payload: formatted
        });

        if (event.type === AGENT_EVENT_TYPE.APPROVAL_REQUEST) {
          this.conversationStore.patch(conversation.id, {
            lastPendingApprovalId: event?.payload?.approvalId || null
          });
        }

        if (event.type === AGENT_EVENT_TYPE.QUESTION) {
          this.conversationStore.patch(conversation.id, {
            lastPendingQuestionId: event?.payload?.questionId || null
          });
        }

        if (event.type === AGENT_EVENT_TYPE.COMPLETED || event.type === AGENT_EVENT_TYPE.FAILED) {
          this.conversationStore.patch(conversation.id, {
            lastPendingApprovalId: null,
            lastPendingQuestionId: null
          });
        }

        this.conversationStore.patch(
          conversation.id,
          this.buildConversationSupervisorPatch({ conversation, session, event })
        );
      } catch (error) {
        this.deliveryStore.saveOutbound({
          channel: conversation.channel,
          conversationId: conversation.id,
          sessionId: event.sessionId,
          eventSeq: event.seq,
          status: 'failed',
          error: error.message,
          payload: formatted
        });
      }
    }
  }
}

export const agentChannelOutboundDispatcher = new AgentChannelOutboundDispatcher();

export default agentChannelOutboundDispatcher;
