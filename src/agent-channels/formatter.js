import { AGENT_EVENT_TYPE } from '../agent-runtime/models.js';

export function formatAgentRuntimeEventForChannel({ event, session } = {}) {
  const providerLabel = session?.provider || event?.payload?.provider || 'agent';

  switch (event?.type) {
    case AGENT_EVENT_TYPE.STARTED:
      return {
        text: `${providerLabel} task started: ${event?.payload?.title || session?.title || 'Untitled task'}`,
        buttons: []
      };
    case AGENT_EVENT_TYPE.APPROVAL_REQUEST:
      return {
        text: `${providerLabel} requires approval: ${event?.payload?.title || 'Permission request'}\n${event?.payload?.summary || ''}`.trim(),
        buttons: [
          { id: 'approve', text: 'Approve', action: 'approve', approvalId: event?.payload?.approvalId },
          { id: 'deny', text: 'Deny', action: 'deny', approvalId: event?.payload?.approvalId }
        ]
      };
    case AGENT_EVENT_TYPE.QUESTION:
      return {
        text: `${providerLabel} asks: ${event?.payload?.text || ''}`.trim(),
        buttons: []
      };
    case AGENT_EVENT_TYPE.COMPLETED:
      return {
        text: `${providerLabel} task completed.\n${event?.payload?.summary || session?.summary || ''}`.trim(),
        buttons: []
      };
    case AGENT_EVENT_TYPE.FAILED:
      return {
        text: `${providerLabel} task failed: ${event?.payload?.message || session?.error || 'Unknown error'}`,
        buttons: []
      };
    default:
      return null;
  }
}

export default {
  formatAgentRuntimeEventForChannel
};
