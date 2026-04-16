import crypto from 'crypto';

export const AGENT_SESSION_STATUS = Object.freeze({
  STARTING: 'starting',
  RUNNING: 'running',
  WAITING_USER: 'waiting_user',
  WAITING_APPROVAL: 'waiting_approval',
  READY: 'ready',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

export const AGENT_EVENT_TYPE = Object.freeze({
  STARTED: 'worker.started',
  PROGRESS: 'worker.progress',
  MESSAGE: 'worker.message',
  COMMAND: 'worker.command',
  FILE_CHANGE: 'worker.file_change',
  QUESTION: 'worker.question',
  APPROVAL_REQUEST: 'worker.approval_request',
  APPROVAL_RESOLVED: 'worker.approval_resolved',
  COMPLETED: 'worker.completed',
  FAILED: 'worker.failed'
});

export function createAgentSession({
  provider,
  input,
  cwd = process.cwd(),
  model = '',
  title = '',
  metadata = {}
} = {}) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    provider,
    status: AGENT_SESSION_STATUS.STARTING,
    cwd,
    model,
    title: title || summarizeTitle(input),
    summary: '',
    createdAt: now,
    updatedAt: now,
    providerSessionId: null,
    currentTurnId: null,
    turnCount: 0,
    pid: null,
    error: null,
    metadata
  };
}

export function createAgentEvent(sessionId, seq, type, payload = {}) {
  return {
    sessionId,
    seq,
    ts: new Date().toISOString(),
    type,
    payload
  };
}

export function summarizeTitle(input) {
  const text = String(input || '').trim().replace(/\s+/g, ' ');
  return text.slice(0, 80) || 'Untitled agent task';
}

