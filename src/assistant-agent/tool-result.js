function normalizeText(value) {
  return String(value || '').trim();
}

function buildFallbackSummary(toolName = '', status = '', content = []) {
  const text = normalizeText(content?.[0]?.text || '');
  if (text) return text;
  if (status === 'completed') return `Tool ${toolName} completed`;
  if (status === 'requires_approval') return `Tool ${toolName} requires confirmation`;
  if (status === 'denied') return `Tool ${toolName} denied`;
  if (status === 'failed') return `Tool ${toolName} failed`;
  return `Tool ${toolName} finished`;
}

export function getToolResultPayload(entry = {}) {
  if (entry && typeof entry === 'object' && 'result' in entry) {
    return entry.result;
  }
  if (entry && typeof entry === 'object' && 'structured' in entry) {
    return entry.structured;
  }
  return entry ?? null;
}

export function normalizeAssistantToolResultEntry(entry = {}, fallback = {}) {
  const payload = getToolResultPayload(entry);
  const rawStatus = normalizeText(entry?.status);
  const success = typeof entry?.success === 'boolean'
    ? entry.success
    : rawStatus === 'completed';
  const summary = normalizeText(entry?.summary)
    || normalizeText(payload?.summary)
    || buildFallbackSummary(entry?.toolName || fallback.toolName || '', rawStatus, entry?.content);

  return {
    toolName: normalizeText(entry?.toolName || fallback.toolName),
    input: (entry?.input && typeof entry.input === 'object') ? entry.input : (fallback.input || {}),
    success,
    summary,
    status: rawStatus || (success ? 'completed' : 'failed'),
    startedAt: normalizeText(entry?.startedAt),
    completedAt: normalizeText(entry?.completedAt),
    payload,
    policy: entry?.policy || entry?.metadata?.policy || null,
    content: Array.isArray(entry?.content) ? entry.content : [],
    metadata: entry?.metadata && typeof entry.metadata === 'object' ? entry.metadata : {}
  };
}

export function extractToolResultSession(entry = {}) {
  const payload = normalizeAssistantToolResultEntry(entry).payload;
  if (!payload || typeof payload !== 'object') return null;
  if (payload.session?.id) return payload.session;
  if (payload.id && payload.provider && payload.status) return payload;
  return null;
}

export function getToolResultPendingCounts(entry = {}) {
  const payload = normalizeAssistantToolResultEntry(entry).payload;
  const approvals = Array.isArray(payload?.pendingApprovals) ? payload.pendingApprovals.length : Number(payload?.pendingApprovals || 0);
  const questions = Array.isArray(payload?.pendingQuestions) ? payload.pendingQuestions.length : Number(payload?.pendingQuestions || 0);
  return {
    approvals,
    questions
  };
}

export function isToolResultConfirmationRequired(entry = {}) {
  const payload = normalizeAssistantToolResultEntry(entry).payload;
  return payload?.kind === 'policy_block'
    && (payload?.requiresConfirmation === true || payload?.requiresApproval === true);
}

export function stringifyAssistantToolResult(entry = {}) {
  return JSON.stringify(getToolResultPayload(entry) ?? null, null, 2);
}

export default {
  getToolResultPayload,
  normalizeAssistantToolResultEntry,
  extractToolResultSession,
  getToolResultPendingCounts,
  isToolResultConfirmationRequired,
  stringifyAssistantToolResult
};
