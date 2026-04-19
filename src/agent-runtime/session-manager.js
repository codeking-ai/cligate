import { logger } from '../utils/logger.js';
import AgentRuntimeApprovalService from './approval-service.js';
import agentRuntimeApprovalPolicyStore, { AgentRuntimeApprovalPolicyStore } from './approval-policy-store.js';
import AgentRuntimeEventBus from './event-bus.js';
import { createAgentEvent, createAgentSession, AGENT_EVENT_TYPE, AGENT_SESSION_STATUS } from './models.js';
import { createDefaultAgentRuntimeRegistry } from './registry.js';
import AgentRuntimeSessionStore from './session-store.js';

function nowIso() {
  return new Date().toISOString();
}

export class AgentRuntimeSessionManager {
  constructor({
    registry = createDefaultAgentRuntimeRegistry(),
    store = new AgentRuntimeSessionStore(),
    eventBus = new AgentRuntimeEventBus(),
    approvalService = new AgentRuntimeApprovalService(),
    approvalPolicyStore = agentRuntimeApprovalPolicyStore
  } = {}) {
    this.registry = registry;
    this.store = store;
    this.eventBus = eventBus;
    this.approvalService = approvalService;
    this.approvalPolicyStore = approvalPolicyStore instanceof AgentRuntimeApprovalPolicyStore
      ? approvalPolicyStore
      : approvalPolicyStore;
    this.questionsBySession = new Map();
    this.sessions = new Map();
    this.seqBySession = new Map();
    this.turnHandles = new Map();

    for (const session of this.store.loadSessions()) {
      const normalized = this._normalizeLoadedSession(session);
      this.sessions.set(normalized.id, normalized);
      this.seqBySession.set(normalized.id, Number(normalized.lastEventSeq || 0));
    }
  }

  _normalizeLoadedSession(session) {
    if (!session) return session;
    if (session.status === AGENT_SESSION_STATUS.STARTING || session.status === AGENT_SESSION_STATUS.RUNNING) {
      return {
        ...session,
        status: AGENT_SESSION_STATUS.FAILED,
        error: session.error || 'Session interrupted during previous runtime',
        updatedAt: nowIso()
      };
    }
    return session;
  }

  _persistSessions() {
    const sessions = [...this.sessions.values()]
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
    this.store.saveSessions(sessions);
  }

  _saveSession(session) {
    this.sessions.set(session.id, session);
    this._persistSessions();
    return session;
  }

  _patchSession(sessionId, patch = {}) {
    const current = this.getSession(sessionId);
    if (!current) return null;
    const updated = {
      ...current,
      ...patch,
      updatedAt: nowIso()
    };
    return this._saveSession(updated);
  }

  _emitEvent(sessionId, type, payload = {}) {
    const nextSeq = (this.seqBySession.get(sessionId) || 0) + 1;
    this.seqBySession.set(sessionId, nextSeq);
    const event = createAgentEvent(sessionId, nextSeq, type, payload);
    const session = this.getSession(sessionId);
    if (session) {
      session.lastEventSeq = nextSeq;
      session.updatedAt = event.ts;
      this.sessions.set(sessionId, session);
      this._persistSessions();
    }
    this.store.appendEvent(sessionId, event);
    this.eventBus.publish(event);
    return event;
  }

  _refreshInteractiveState(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;

    const pendingApprovals = this.approvalService.listPending(sessionId).length;
    const pendingQuestions = (this.questionsBySession.get(sessionId) || [])
      .filter((entry) => entry.status === 'pending')
      .length;

    if (pendingApprovals > 0) {
      return this._patchSession(sessionId, {
        status: AGENT_SESSION_STATUS.WAITING_APPROVAL
      });
    }

    if (pendingQuestions > 0) {
      return this._patchSession(sessionId, {
        status: AGENT_SESSION_STATUS.WAITING_USER
      });
    }

    return this._patchSession(sessionId, {
      status: AGENT_SESSION_STATUS.RUNNING
    });
  }

  listProviders() {
    return this.registry.list();
  }

  listSessions({ limit = 50 } = {}) {
    return [...this.sessions.values()]
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, Math.max(1, limit));
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  getEvents(sessionId, options = {}) {
    const recent = this.eventBus.getRecentEvents(sessionId, options.limit || 200);
    if (recent.length > 0) {
      const afterSeq = Number(options.afterSeq || 0);
      return recent.filter((event) => event.seq > afterSeq);
    }
    return this.store.listEvents(sessionId, options);
  }

  subscribe(sessionId, listener) {
    return this.eventBus.subscribe(sessionId, listener);
  }

  async createSession({ provider, input, cwd, model = '', metadata = {} } = {}) {
    if (!provider || typeof provider !== 'string') {
      throw new Error('provider is required');
    }
    if (!input || typeof input !== 'string' || !input.trim()) {
      throw new Error('input is required');
    }

    const runtimeProvider = this.registry.get(provider);
    if (!runtimeProvider) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    const session = createAgentSession({
      provider,
      input,
      cwd,
      model,
      metadata
    });
    this._saveSession(session);
    this._emitEvent(session.id, AGENT_EVENT_TYPE.STARTED, {
      provider,
      title: session.title,
      cwd: session.cwd,
      model: session.model
    });

    try {
      await this._startTurn(session.id, input);
    } catch (error) {
      this._patchSession(session.id, {
        status: AGENT_SESSION_STATUS.FAILED,
        error: error.message || 'Failed to start worker session',
        currentTurnId: null
      });
      this._emitEvent(session.id, AGENT_EVENT_TYPE.FAILED, {
        message: error.message || 'Failed to start worker session'
      });
      throw error;
    }
    return this.getSession(session.id);
  }

  async sendInput(sessionId, input) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('session not found');
    }
    if (!input || typeof input !== 'string' || !input.trim()) {
      throw new Error('input is required');
    }
    if (this.turnHandles.has(sessionId)) {
      throw new Error('session is already running');
    }

    await this._startTurn(sessionId, input);
    return this.getSession(sessionId);
  }

  async resolveApproval(sessionId, approvalId, decision) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('session not found');
    }

    const approval = this.approvalService.resolveApproval(sessionId, approvalId, decision);
    if (!approval) {
      throw new Error('approval not found');
    }

    const handle = this.turnHandles.get(sessionId);
    if (handle?.respondApproval) {
      await handle.respondApproval({ approval, decision });
    } else {
      const provider = this.registry.get(session.provider);
      if (!provider?.respondApproval) {
        throw new Error(`Provider ${session.provider} does not support approval responses`);
      }
      await provider.respondApproval({ session, approval, decision });
    }
    this._refreshInteractiveState(sessionId);
    this._emitEvent(sessionId, AGENT_EVENT_TYPE.APPROVAL_RESOLVED, {
      approvalId,
      decision: approval.status
    });
    return approval;
  }

  listPendingQuestions(sessionId) {
    return this.questionsBySession.get(sessionId) || [];
  }

  async answerQuestion(sessionId, questionId, answer) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('session not found');
    }

    const questions = this.questionsBySession.get(sessionId) || [];
    const question = questions.find((entry) => entry.questionId === questionId && entry.status === 'pending');
    if (!question) {
      throw new Error('question not found');
    }

    const handle = this.turnHandles.get(sessionId);
    if (!handle?.respondQuestion) {
      throw new Error(`Provider ${session.provider} does not support question responses`);
    }

    await handle.respondQuestion({ question, answer });
    question.status = 'answered';
    question.answeredAt = nowIso();
    this._refreshInteractiveState(sessionId);
    return question;
  }

  cancelSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('session not found');
    }

    const handle = this.turnHandles.get(sessionId);
    handle?.cancel?.();
    this.turnHandles.delete(sessionId);

    const updated = this._patchSession(sessionId, {
      status: AGENT_SESSION_STATUS.CANCELLED,
      error: null
    });

    this._emitEvent(sessionId, AGENT_EVENT_TYPE.FAILED, {
      message: 'Session cancelled by user'
    });

    return updated;
  }

  async _startTurn(sessionId, input) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('session not found');
    }

    const provider = this.registry.get(session.provider);
    if (!provider) {
      throw new Error(`Provider ${session.provider} is unavailable`);
    }

    const turnId = `${session.id}:turn:${session.turnCount + 1}`;
    const turnState = { settled: false };
    let handle = null;
    const deferredApprovalResponses = [];
    const patched = this._patchSession(sessionId, {
      status: AGENT_SESSION_STATUS.RUNNING,
      currentTurnId: turnId,
      turnCount: Number(session.turnCount || 0) + 1,
      error: null
    });

    logger.info(`[AgentRuntime] Starting ${patched.provider} turn ${patched.turnCount} | session=${patched.id}`);

    handle = await provider.startTurn({
      session: patched,
      input,
      onProviderEvent: ({ type, payload }) => {
        this._emitEvent(sessionId, type, payload);
      },
      onApprovalRequest: ({ kind = 'tool_permission', title, summary, rawRequest }) => {
        const approval = this.approvalService.createApproval({
          sessionId,
          provider: patched.provider,
          kind,
          title,
          summary,
          rawRequest
        });
        const conversationId = patched?.metadata?.source?.conversationId || patched?.metadata?.conversationId || '';
        const rememberedPolicy = this.approvalPolicyStore?.findFirstMatchingPolicy?.({
          candidates: [
            conversationId ? { scope: 'conversation', scopeRef: conversationId } : null,
            { scope: 'session', scopeRef: sessionId }
          ].filter(Boolean),
          provider: patched.provider,
          rawRequest
        });

        if (rememberedPolicy) {
          this.approvalService.resolveApproval(sessionId, approval.approvalId, 'approve');
          this._emitEvent(sessionId, AGENT_EVENT_TYPE.PROGRESS, {
            phase: 'approval_auto_resolved',
            approvalId: approval.approvalId,
            policyId: rememberedPolicy.id,
            message: 'Supervisor auto-approved this request using a remembered session rule.'
          });
          const runResponse = async () => {
            if (!handle?.respondApproval) {
              deferredApprovalResponses.push({
                approval: { ...approval, status: 'approved' },
                decision: 'approve',
                policyId: rememberedPolicy.id
              });
              return;
            }
            await handle.respondApproval({ approval: { ...approval, status: 'approved' }, decision: 'approve' });
          };
          Promise.resolve(runResponse())
            .then(() => {
              if (!handle?.respondApproval) return;
              this._emitEvent(sessionId, AGENT_EVENT_TYPE.APPROVAL_RESOLVED, {
                approvalId: approval.approvalId,
                decision: 'approved',
                autoApproved: true,
                policyId: rememberedPolicy.id
              });
              this._refreshInteractiveState(sessionId);
            })
            .catch((error) => {
              this._patchSession(sessionId, {
                status: AGENT_SESSION_STATUS.FAILED,
                error: error?.message || 'Failed to auto-resolve approval',
                currentTurnId: null
              });
              this._emitEvent(sessionId, AGENT_EVENT_TYPE.FAILED, {
                message: error?.message || 'Failed to auto-resolve approval'
              });
            });
          return;
        }
        this._patchSession(sessionId, {
          status: AGENT_SESSION_STATUS.WAITING_APPROVAL
        });
        this._emitEvent(sessionId, AGENT_EVENT_TYPE.APPROVAL_REQUEST, approval);
      },
      onQuestionRequest: ({ text, options = [], rawRequest = null, questionId = null }) => {
        const questions = this.questionsBySession.get(sessionId) || [];
        const question = {
          questionId: questionId || `${sessionId}:question:${questions.length + 1}`,
          sessionId,
          provider: patched.provider,
          status: 'pending',
          text: String(text || ''),
          options: Array.isArray(options) ? options : [],
          rawRequest,
          createdAt: nowIso(),
          answeredAt: null
        };
        questions.push(question);
        this.questionsBySession.set(sessionId, questions);
        this._patchSession(sessionId, {
          status: AGENT_SESSION_STATUS.WAITING_USER
        });
        this._emitEvent(sessionId, AGENT_EVENT_TYPE.QUESTION, question);
      },
      onSessionPatch: (delta) => {
        this._patchSession(sessionId, delta);
      },
      onTurnFinished: ({ status = 'ready', summary = '' } = {}) => {
        turnState.settled = true;
        this.turnHandles.delete(sessionId);
        this._patchSession(sessionId, {
          status: status === 'ready' ? AGENT_SESSION_STATUS.READY : status,
          summary,
          currentTurnId: null
        });
        this.questionsBySession.delete(sessionId);
      },
      onTurnFailed: (error) => {
        turnState.settled = true;
        this.turnHandles.delete(sessionId);
        const message = error?.message || 'Worker turn failed';
        this._patchSession(sessionId, {
          status: AGENT_SESSION_STATUS.FAILED,
          error: message,
          currentTurnId: null
        });
        this.questionsBySession.delete(sessionId);
        this._emitEvent(sessionId, AGENT_EVENT_TYPE.FAILED, {
          message
        });
      }
    });

    for (const deferred of deferredApprovalResponses) {
      await handle.respondApproval?.({
        approval: deferred.approval,
        decision: deferred.decision
      });
      this._emitEvent(sessionId, AGENT_EVENT_TYPE.APPROVAL_RESOLVED, {
        approvalId: deferred.approval.approvalId,
        decision: 'approved',
        autoApproved: true,
        policyId: deferred.policyId
      });
      this._refreshInteractiveState(sessionId);
    }

    if (handle?.pid) {
      this._patchSession(sessionId, { pid: handle.pid });
    }
    if (!turnState.settled) {
      this.turnHandles.set(sessionId, handle);
    }
  }
}

export const agentRuntimeSessionManager = new AgentRuntimeSessionManager();

export default agentRuntimeSessionManager;
