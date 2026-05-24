import createDefaultAssistantToolRegistry, { AssistantToolRegistry } from './tool-registry.js';
import assistantPolicyService, { AssistantPolicyService } from './policy-service.js';
import artifactService from './artifact-service.js';

function nowIso() {
  return new Date().toISOString();
}

function buildPolicyToolResult(tool, call, policy, summary, result = {}) {
  const completedAt = nowIso();
  return {
    toolName: tool.name,
    input: call.input || {},
    startedAt: completedAt,
    completedAt,
    success: false,
    policy,
    summary,
    result
  };
}

function summarizeResult(result) {
  if (result == null) return 'No result';
  if (Array.isArray(result)) return `Returned ${result.length} items`;
  if (typeof result === 'object') {
    if (result.id) return `Returned object ${result.id}`;
    if (result.session?.id) return `Returned session ${result.session.id}`;
    if (result.conversation?.id) return `Returned conversation ${result.conversation.id}`;
    return `Returned object with keys: ${Object.keys(result).slice(0, 6).join(', ')}`;
  }
  return String(result).slice(0, 160);
}

function buildArtifactMetadataForToolResult(call = {}, result = {}, context = {}) {
  const toolName = String(call?.toolName || '').trim();
  if (toolName !== 'view_image' || !result || typeof result !== 'object') {
    return null;
  }
  const imageUrl = String(result.imageUrl || '').trim()
    || (Array.isArray(result.content)
      ? String(result.content.find((entry) => entry?.type === 'input_image')?.image_url || '').trim()
      : '');
  const path = String(result.path || call?.input?.path || '').trim();
  if (!imageUrl && !path) {
    return null;
  }
  const conversationId = String(context?.conversation?.id || '').trim();
  const metadata = context?.run?.metadata && typeof context.run.metadata === 'object'
    ? context.run.metadata
    : {};
  const assistantTaskId = String(metadata?.assistantTaskId || '').trim();
  const assistantProjectId = String(metadata?.assistantProjectId || '').trim();
  const assistantExecutionId = String(metadata?.assistantExecutionId || '').trim();
  const artifact = artifactService.createArtifact({
    kind: 'image',
    source: 'view_image',
    conversationId,
    taskId: assistantTaskId,
    projectId: assistantProjectId,
    executionId: assistantExecutionId,
    assistantRunId: String(context?.run?.id || '').trim(),
    role: 'assistant',
    title: path || 'viewed image',
    summary: path ? `Assistant viewed image: ${path}` : 'Assistant viewed an image.',
    mediaType: String(result.media_type || '').trim(),
    path,
    imageUrl,
    metadata: {
      detail: String(result.detail || call?.input?.detail || '').trim()
    }
  });
  return {
    artifactId: artifact.id
  };
}

export class AssistantToolExecutor {
  constructor({
    toolRegistry = createDefaultAssistantToolRegistry(),
    policyService = assistantPolicyService
  } = {}) {
    this.toolRegistry = toolRegistry instanceof AssistantToolRegistry
      ? toolRegistry
      : toolRegistry;
    this.policyService = policyService instanceof AssistantPolicyService
      ? policyService
      : policyService;
  }

  async executeToolCall(call = {}, context = {}) {
    const tool = this.toolRegistry.get(call.toolName);
    if (!tool) {
      // Return a structured failure instead of throwing so the supervisor LLM
      // can see "this tool doesn't exist, try another" and recover, rather
      // than the whole ReactEngine collapsing into the fallback runner.
      const ts = nowIso();
      return {
        toolName: String(call.toolName || ''),
        input: call.input || {},
        startedAt: ts,
        completedAt: ts,
        success: false,
        policy: null,
        summary: `Unknown assistant tool: ${call.toolName}`,
        result: {
          kind: 'tool_not_found',
          error: `Unknown assistant tool: ${call.toolName}`,
          recoverable: true,
          hint: 'This tool name is not registered. Pick a tool that appears in the available tool list.'
        }
      };
    }

    const policy = this.policyService?.canExecuteToolCall?.({
      toolName: call.toolName,
      conversation: context.conversation || null,
      runtimeSession: context.runtimeSession || null,
      cwd: context.run?.metadata?.plan?.cwd || context.conversation?.metadata?.workspaceId || '',
      metadata: context.run?.metadata || {},
      input: call.input || {}
    });
    if (policy && policy.allowed === false) {
      // Surface policy denials as a structured tool result rather than a
      // throw. Throwing here used to escape the ReactEngine and dump the
      // whole dialogue into the deterministic fallback runner (the "回退到
      // 基础 assistant 流程" canned message). The supervisor LLM can now
      // read the denial reason and either pick a different tool or reply
      // honestly to the user.
      const ts = nowIso();
      return {
        toolName: tool.name,
        input: call.input || {},
        startedAt: ts,
        completedAt: ts,
        success: false,
        policy,
        summary: `Tool ${tool.name} blocked by policy: ${policy.reason || 'tool_not_permitted_by_policy'}`,
        result: {
          kind: 'policy_block',
          reason: policy.reason || 'tool_not_permitted_by_policy',
          recoverable: true,
          requiresConfirmation: false,
          hint: 'This tool is not permitted in the current scope. Try a different tool, or tell the user what is blocking the action.'
        }
      };
    }
    if (policy?.requiresConfirmation) {
      return buildPolicyToolResult(
        tool,
        call,
        policy,
        `Tool ${call.toolName} requires confirmation (${policy.reason})`,
        {
          kind: 'policy_block',
          requiresConfirmation: true,
          reason: policy.reason,
          hint: 'This tool call requires confirmation. Ask the user for confirmation or choose a non-mutating path.'
        }
      );
    }

    const startedAt = nowIso();
    let result;
    try {
      result = await tool.execute({
        input: call.input || {},
        context
      });
    } catch (error) {
      // Convert tool throws into a structured failure so the supervisor LLM
      // can read the error and decide a recovery (e.g. delegate_to_codex
      // with a fresh session) instead of the entire dialogue collapsing to
      // the deterministic fallback runner. Without this, a transient runtime
      // error like "session is already running" makes the user see the
      // canned "fallback assistant" message.
      const completedAt = nowIso();
      const message = String(error?.message || error || 'tool execution failed').trim();
      return {
        toolName: tool.name,
        input: call.input || {},
        startedAt,
        completedAt,
        success: false,
        policy,
        summary: `Tool ${tool.name} failed: ${message.slice(0, 200)}`,
        result: {
          kind: 'tool_error',
          error: message,
          recoverable: true,
          hint: 'The tool call failed. Decide whether to retry with adjusted input (e.g. start a fresh session with delegate_to_codex), to use a different tool, or to tell the user what happened.'
        }
      };
    }
    const completedAt = nowIso();
    const artifactMetadata = buildArtifactMetadataForToolResult(call, result, context);

    return {
      toolName: tool.name,
      input: call.input || {},
      startedAt,
      completedAt,
      success: true,
      policy,
      summary: summarizeResult(result),
      result,
      metadata: artifactMetadata || {}
    };
  }
}

export default AssistantToolExecutor;

