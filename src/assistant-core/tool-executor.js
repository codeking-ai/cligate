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

// Tools whose result is an image we register as an artifact so it can later be
// referenced by a stable id (e.g. forwarded on a channel) instead of a fragile
// file path the LLM has to re-type. view_image is a deliberate, low-frequency
// "look at this"; desktop screenshots are high-frequency verification captures.
const IMAGE_ARTIFACT_TOOLS = new Set(['view_image', 'desktop_capture_window', 'desktop_inspect_window']);

function buildArtifactMetadataForToolResult(call = {}, result = {}, context = {}) {
  const toolName = String(call?.toolName || '').trim();
  if (!IMAGE_ARTIFACT_TOOLS.has(toolName) || !result || typeof result !== 'object') {
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
  // Desktop screenshots fire on nearly every verification step, so — unlike a
  // deliberate view_image — we do NOT attach them to the conversation/task/run.
  // Attaching would flood listRelevantArtifacts and crowd out meaningful
  // artifacts. We still register them (resolvable by id via getArtifact) so a
  // screenshot can be forwarded by a stable imageArtifactId.
  const isDesktopCapture = toolName !== 'view_image';
  const metadata = context?.run?.metadata && typeof context.run.metadata === 'object'
    ? context.run.metadata
    : {};
  const artifact = artifactService.createArtifact({
    kind: 'image',
    source: isDesktopCapture ? 'desktop_capture' : 'view_image',
    conversationId: isDesktopCapture ? '' : String(context?.conversation?.id || '').trim(),
    taskId: isDesktopCapture ? '' : String(metadata?.assistantTaskId || '').trim(),
    projectId: isDesktopCapture ? '' : String(metadata?.assistantProjectId || '').trim(),
    executionId: isDesktopCapture ? '' : String(metadata?.assistantExecutionId || '').trim(),
    assistantRunId: isDesktopCapture ? '' : String(context?.run?.id || '').trim(),
    role: 'assistant',
    title: path || (isDesktopCapture ? 'desktop screenshot' : 'viewed image'),
    summary: isDesktopCapture
      ? `Desktop screenshot${path ? `: ${path}` : ''}`
      : (path ? `Assistant viewed image: ${path}` : 'Assistant viewed an image.'),
    mediaType: String(result.media_type || '').trim() || (isDesktopCapture ? 'image/png' : ''),
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
    // Surface the artifact handle in the RESULT the LLM actually sees:
    // stringifyAssistantToolResult only serializes `result`, NOT this top-level
    // `metadata`, so without this the model could not learn the id to forward a
    // screenshot by imageArtifactId.
    const resultForModel = (artifactMetadata?.artifactId && result && typeof result === 'object' && !Array.isArray(result))
      ? { ...result, imageArtifactId: artifactMetadata.artifactId }
      : result;

    return {
      toolName: tool.name,
      input: call.input || {},
      startedAt,
      completedAt,
      success: true,
      policy,
      summary: summarizeResult(result),
      result: resultForModel,
      metadata: artifactMetadata || {}
    };
  }
}

export default AssistantToolExecutor;

