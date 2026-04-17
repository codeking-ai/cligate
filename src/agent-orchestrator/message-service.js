import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';

function parseLeadingCommand(input) {
  const text = String(input || '').trim();
  if (!text.startsWith('/')) {
    return null;
  }

  const match = text.match(/^\/([a-zA-Z-]+)(?:\s+(.+))?$/s);
  if (!match) return null;
  return {
    command: match[1].toLowerCase(),
    args: String(match[2] || '').trim()
  };
}

function parseAgentCommand(args) {
  const match = String(args || '').match(/^(codex|claude(?:-code)?)\s+(.+)$/is);
  if (!match) return null;
  return {
    provider: match[1].toLowerCase().startsWith('claude') ? 'claude-code' : 'codex',
    input: String(match[2] || '').trim()
  };
}

function buildResetResponse(message, activeSessionId = null) {
  return {
    type: 'conversation_reset',
    message,
    previousSessionId: activeSessionId || null
  };
}

export class AgentOrchestratorMessageService {
  constructor({
    runtimeSessionManager = agentRuntimeSessionManager
  } = {}) {
    this.runtimeSessionManager = runtimeSessionManager;
  }

  async startRuntimeTask({ provider, input, cwd, model = '', metadata = {} } = {}) {
    return this.runtimeSessionManager.createSession({
      provider,
      input,
      cwd,
      model,
      metadata
    });
  }

  async continueRuntimeTask({ sessionId, input } = {}) {
    return this.runtimeSessionManager.sendInput(String(sessionId || ''), input);
  }

  async resolveApproval({ sessionId, approvalId, decision } = {}) {
    return this.runtimeSessionManager.resolveApproval(
      String(sessionId || ''),
      String(approvalId || ''),
      String(decision || '')
    );
  }

  async answerQuestion({ sessionId, questionId, answer } = {}) {
    return this.runtimeSessionManager.answerQuestion(
      String(sessionId || ''),
      String(questionId || ''),
      answer
    );
  }

  cancelRuntimeSession({ sessionId } = {}) {
    return this.runtimeSessionManager.cancelSession(String(sessionId || ''));
  }

  getRuntimeSession(sessionId) {
    return this.runtimeSessionManager.getSession(String(sessionId || ''));
  }

  listPendingQuestions(sessionId) {
    return this.runtimeSessionManager.listPendingQuestions(String(sessionId || ''));
  }

  listPendingApprovals(sessionId) {
    return this.runtimeSessionManager.approvalService.listPending(String(sessionId || ''));
  }

  async routeUserMessage({
    message,
    conversation = null,
    defaultRuntimeProvider = 'codex',
    cwd,
    model = '',
    metadata = {}
  } = {}) {
    const text = String(message?.text || '').trim();
    if (!text) {
      throw new Error('message text is required');
    }

    const parsed = parseLeadingCommand(text);
    const activeSessionId = conversation?.activeRuntimeSessionId || null;
    const pendingApprovalId = conversation?.lastPendingApprovalId || null;
    const pendingQuestionId = conversation?.lastPendingQuestionId || null;

    if (parsed?.command === 'agent') {
      const spec = parseAgentCommand(parsed.args);
      if (!spec) {
        return {
          type: 'command_error',
          message: 'Usage: /agent codex <task> or /agent claude <task>'
        };
      }

      const session = await this.startRuntimeTask({
        provider: spec.provider,
        input: spec.input,
        cwd,
        model,
        metadata
      });

      return {
        type: 'runtime_started',
        provider: spec.provider,
        session
      };
    }

    if (parsed?.command === 'new') {
      if (!parsed.args) {
        return buildResetResponse(
          activeSessionId
            ? 'Detached the active runtime session. Your next message will start a fresh task.'
            : 'No active runtime session is attached. Your next message will start a fresh task.',
          activeSessionId
        );
      }

      const spec = parseAgentCommand(parsed.args);
      const provider = spec?.provider || defaultRuntimeProvider;
      const input = spec?.input || parsed.args;
      const session = await this.startRuntimeTask({
        provider,
        input,
        cwd,
        model,
        metadata
      });

      return {
        type: 'runtime_started',
        provider,
        session,
        startedFresh: true,
        replacedSessionId: activeSessionId
      };
    }

    if (parsed?.command === 'detach') {
      return buildResetResponse(
        activeSessionId
          ? 'Detached the active runtime session from this conversation.'
          : 'No active runtime session is attached to this conversation.',
        activeSessionId
      );
    }

    if (parsed?.command === 'continue') {
      if (!activeSessionId) {
        return {
          type: 'command_error',
          message: 'No active runtime session to continue'
        };
      }
      const session = await this.continueRuntimeTask({
        sessionId: activeSessionId,
        input: parsed.args || text
      });
      return {
        type: 'runtime_continued',
        session
      };
    }

    if (parsed?.command === 'cancel') {
      if (!activeSessionId) {
        return {
          type: 'command_error',
          message: 'No active runtime session to cancel'
        };
      }
      return {
        type: 'runtime_cancelled',
        session: this.cancelRuntimeSession({ sessionId: activeSessionId })
      };
    }

    if (parsed?.command === 'status') {
      if (!activeSessionId) {
        return {
          type: 'command_error',
          message: 'No active runtime session'
        };
      }
      return {
        type: 'runtime_status',
        session: this.getRuntimeSession(activeSessionId)
      };
    }

    if (parsed?.command === 'approve' || parsed?.command === 'deny') {
      if (!activeSessionId || !pendingApprovalId) {
        return {
          type: 'command_error',
          message: 'No pending approval request'
        };
      }
      const approval = await this.resolveApproval({
        sessionId: activeSessionId,
        approvalId: pendingApprovalId,
        decision: parsed.command === 'approve' ? 'approve' : 'deny'
      });
      return {
        type: 'approval_resolved',
        approval
      };
    }

    if (activeSessionId && pendingQuestionId) {
      const question = await this.answerQuestion({
        sessionId: activeSessionId,
        questionId: pendingQuestionId,
        answer: text
      });
      return {
        type: 'question_answered',
        question
      };
    }

    if (activeSessionId) {
      const session = await this.continueRuntimeTask({
        sessionId: activeSessionId,
        input: text
      });
      return {
        type: 'runtime_continued',
        session
      };
    }

    const session = await this.startRuntimeTask({
      provider: defaultRuntimeProvider,
      input: text,
      cwd,
      model,
      metadata
    });

    return {
      type: 'runtime_started',
      provider: defaultRuntimeProvider,
      session
    };
  }
}

export const agentOrchestratorMessageService = new AgentOrchestratorMessageService();

export default agentOrchestratorMessageService;
