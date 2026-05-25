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

function isEmptyValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.length === 0) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/**
 * Validate a tool invocation against its declared inputSchema.required list.
 *
 * The supervisor's tool_use args sometimes come back truncated (max_tokens hit
 * mid-JSON) or upstream-corrupted, and the response translator falls back to
 * `input: {}` rather than failing. Without this gate that empty object would
 * reach handlers like writeFile, which then treat the missing path as the cwd
 * (e.g. `D:\`) and crash inside `mkdir(path.dirname('D:\\'))` with EPERM.
 *
 * Returns `null` when the call is valid, or a list of missing field names
 * suitable for surfacing back to the model so it can retry with full args.
 */
function findMissingRequiredFields(tool, input) {
  const required = tool?.inputSchema?.required;
  if (!Array.isArray(required) || required.length === 0) return null;
  const provided = input && typeof input === 'object' ? input : {};
  const missing = required.filter((field) => isEmptyValue(provided[field]));
  return missing.length > 0 ? missing : null;
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

    // Treat translator-flagged truncated arguments and unrecoverable missing
    // required fields the same way: refuse to execute, hand a clear message
    // back to the LLM so it can retry the call with full arguments.
    const truncatedArgs = invocation.metadata?.truncated === true
      || invocation.input?.__truncated === true;
    const missingFields = findMissingRequiredFields(tool, invocation.input || {});
    if (truncatedArgs || missingFields) {
      const reason = truncatedArgs
        ? 'tool_arguments_truncated'
        : 'tool_arguments_missing_required';
      const detail = truncatedArgs
        ? 'The previous turn hit the model output budget mid-arguments, so this tool call arrived with incomplete JSON. Retry the call with concise but complete arguments — consider splitting large content into multiple write_file calls.'
        : `Tool ${tool.name} is missing required field(s): ${missingFields.join(', ')}. Resend the tool call with every required field filled in.`;
      return createToolResult({
        status: 'failed',
        content: [{ type: 'text', text: detail }],
        structured: {
          kind: 'invalid_input',
          toolName: tool.name,
          reason,
          missing: missingFields || [],
          truncated: truncatedArgs
        },
        metadata: { policy, recoverable: true }
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
