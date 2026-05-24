import { performance } from 'node:perf_hooks';
import AssistantToolsRegistry from './registry.js';
import AssistantToolPolicyService from './policy.js';

function createToolResult({
  status,
  content = [],
  structured = null,
  metadata = {}
} = {}) {
  return {
    status,
    content,
    structured,
    metadata
  };
}

export class AssistantToolsExecutor {
  constructor({
    toolRegistry = new AssistantToolsRegistry(),
    policyService = new AssistantToolPolicyService()
  } = {}) {
    this.toolRegistry = toolRegistry;
    this.policyService = policyService;
  }

  async executeToolCall(invocation = {}, context = {}) {
    const tool = this.toolRegistry.get(invocation.toolName);
    const policy = this.policyService.evaluateToolCall({
      tool,
      invocation,
      context
    });

    if (!policy.allowed) {
      return createToolResult({
        status: 'denied',
        content: [{
          type: 'text',
          text: `Tool call denied: ${policy.reason || 'policy_denied'}`
        }],
        structured: {
          kind: 'policy_block',
          toolName: invocation.toolName,
          reason: policy.reason || 'policy_denied'
        },
        metadata: { policy }
      });
    }

    if (policy.requiresApproval) {
      return createToolResult({
        status: 'requires_approval',
        content: [{
          type: 'text',
          text: `Tool call requires approval: ${policy.reason || 'approval_required'}`
        }],
        structured: {
          kind: 'policy_block',
          toolName: invocation.toolName,
          reason: policy.reason || 'approval_required',
          requiresApproval: true,
          requiresConfirmation: true,
          requestedPath: policy.requestedPath || ''
        },
        metadata: { policy }
      });
    }

    const startedAt = performance.now();
    try {
      const structured = await tool.execute({
        input: invocation.input || {},
        context,
        tool,
        invocation
      });
      return createToolResult({
        status: 'completed',
        content: [{
          type: 'text',
          text: `Tool ${tool.name} completed`
        }],
        structured,
        metadata: {
          durationMs: Math.round(performance.now() - startedAt),
          policy
        }
      });
    } catch (error) {
      return createToolResult({
        status: 'failed',
        content: [{
          type: 'text',
          text: String(error?.message || error || 'tool execution failed')
        }],
        structured: {
          kind: 'tool_error',
          toolName: tool.name,
          error: String(error?.message || error || 'tool execution failed')
        },
        metadata: {
          durationMs: Math.round(performance.now() - startedAt),
          policy
        }
      });
    }
  }
}

export default AssistantToolsExecutor;
