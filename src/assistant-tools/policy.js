import WorkspaceGuard from './workspace-guard.js';

function collectPathInputs(input = {}) {
  const values = [];
  if (typeof input.path === 'string' && input.path.trim()) {
    values.push(input.path);
  }
  if (typeof input.cwd === 'string' && input.cwd.trim()) {
    values.push(input.cwd);
  }
  if (Array.isArray(input.paths)) {
    values.push(...input.paths.filter((entry) => typeof entry === 'string' && entry.trim()));
  }
  return values;
}

export class AssistantToolPolicyService {
  constructor({
    workspaceGuard = new WorkspaceGuard(),
    allowMutatingTools = false,
    allowedToolNames = null
  } = {}) {
    this.workspaceGuard = workspaceGuard;
    this.allowMutatingTools = allowMutatingTools;
    this.allowedToolNames = Array.isArray(allowedToolNames)
      ? new Set(allowedToolNames)
      : null;
  }

  evaluateToolCall({ tool = null, invocation = {}, context = {} } = {}) {
    if (!tool?.name) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: 'tool_not_found',
        grantedPermissions: { read: [], write: [] }
      };
    }

    if (this.allowedToolNames && !this.allowedToolNames.has(tool.name)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: 'tool_not_allowed',
        grantedPermissions: { read: [], write: [] }
      };
    }

    const decision = {
      allowed: true,
      requiresApproval: false,
      reason: null,
      grantedPermissions: {
        read: [],
        write: []
      }
    };

    const input = invocation.input || {};
    const baseDir = context.cwd || this.workspaceGuard.workspaceRoot;
    for (const rawPath of collectPathInputs(input)) {
      let resolved;
      try {
        resolved = this.workspaceGuard.resolvePath(rawPath, { baseDir });
      } catch {
        if (tool.mutating) {
          return {
            ...decision,
            allowed: true,
            requiresApproval: invocation.metadata?.approved !== true,
            reason: 'path_outside_workspace_requires_confirmation',
            requestedPath: String(rawPath || '').trim(),
            grantedPermissions: { read: [], write: [] }
          };
        }
        return {
          allowed: false,
          requiresApproval: false,
          reason: 'path_outside_workspace',
          grantedPermissions: { read: [], write: [] }
        };
      }
      if (tool.mutating) {
        decision.grantedPermissions.write.push(resolved);
      } else {
        decision.grantedPermissions.read.push(resolved);
      }
    }

    if (tool.mutating && !this.allowMutatingTools) {
      return {
        ...decision,
        allowed: false,
        reason: 'mutating_tools_disabled'
      };
    }

    if ((tool.requiresApproval || tool.mutating) && invocation.metadata?.approved !== true) {
      return {
        ...decision,
        requiresApproval: true,
        reason: tool.mutating ? 'mutating_tool_requires_confirmation' : 'tool_requires_confirmation'
      };
    }

    return decision;
  }
}

export default AssistantToolPolicyService;
