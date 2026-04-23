import { ASSISTANT_RUN_STATUS } from '../assistant-core/models.js';

function collectSessionCandidates(toolResults = []) {
  return toolResults.flatMap((entry) => {
    const result = entry?.result;
    if (!result || typeof result !== 'object') return [];
    if (result.session?.id) return [result.session];
    if (result.id && result.provider && result.status) return [result];
    return [];
  });
}

export function deriveAssistantRunStatus({ toolResults = [] } = {}) {
  const sessions = collectSessionCandidates(toolResults);
  if (sessions.some((entry) => ['waiting_approval', 'waiting_user'].includes(String(entry?.status || '')))) {
    return ASSISTANT_RUN_STATUS.WAITING_USER;
  }
  if (sessions.some((entry) => ['starting', 'running'].includes(String(entry?.status || '')))) {
    return ASSISTANT_RUN_STATUS.WAITING_RUNTIME;
  }
  return ASSISTANT_RUN_STATUS.COMPLETED;
}

export default {
  deriveAssistantRunStatus
};
