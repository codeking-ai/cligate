import path from 'node:path';
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

function isDesktopTool(tool = null) {
  return String(tool?.name || '').startsWith('desktop_');
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
    // Context-supplied per-call extras (e.g. dirs of active skills) — these
    // permit reads outside the workspace without expanding write authority.
    const extraReadRoots = Array.isArray(context.extraReadRoots) ? context.extraReadRoots : [];
    // Conversation-level "yolo" flag set by the user via /yolo or a sticky
    // approval phrase. When on, every tool call behaves as if approval was
    // already granted — equivalent to invocation.metadata.approved === true.
    const autoApproveAll = context.autoApproveAll === true;
    const effectiveApproved = autoApproveAll || invocation.metadata?.approved === true;

    // desktop_* tools operate at the OS level: they launch executables, click
    // pixels, OCR windows. Their `path` argument is a system path (an installer
    // EXE, a .lnk, a target window's working directory) — NOT a workspace file
    // the assistant intends to read or modify. Gating them by the workspace
    // root is a category error that just blocks "open dingtalk_downloader.exe"
    // because the user's workspace is on a different drive. We still skip the
    // approval prompt for them (line below), and the desktop-agent token / OS
    // UAC gate provide the actual security boundary.
    const skipPathCheck = isDesktopTool(tool);

    if (!skipPathCheck) {
      for (const rawPath of collectPathInputs(input)) {
        let resolved;
        try {
          if (tool.mutating) {
            resolved = this.workspaceGuard.resolvePath(rawPath, { baseDir });
          } else {
            // Reads honor extraReadRoots so the assistant can read files of an
            // active skill (e.g. C:\Users\<user>\.cligate\skills\pptx\editing.md)
            // even when the workspace cwd is a different drive.
            resolved = this.workspaceGuard.resolvePath(rawPath, {
              baseDir,
              extraReadRoots,
              readOnly: true
            });
          }
        } catch {
          // Path is outside the workspace and not in any whitelisted read
          // root. Three branches:
          //
          // 1) effectiveApproved (user typed /yolo, a sticky-approval phrase
          //    like "本对话全部同意 / 我直接同意 / 不用再问我", or the
          //    invocation already carries metadata.approved=true): straight
          //    allow. No extra round-trip. This is the path the user expects
          //    when they explicitly granted blanket consent.
          //
          // 2) Mutating tool, not approved: ask for per-call confirmation
          //    (UI shows an approval card). Writes are dangerous enough that
          //    the per-call prompt is worth the friction.
          //
          // 3) Read-only tool, not approved: hard deny. Earlier we tried
          //    routing reads through the same approval card as writes, but
          //    that introduced a confirmation round-trip the LLM had to
          //    resolve via resolve_assistant_confirmation, after which the
          //    turn ended *without continuing the original work* — the user
          //    perceived the assistant as "stopped executing midway".
          //    Hard-denying instead lets the LLM keep going (e.g. ask for a
          //    path inside the workspace, or surface the deny to the user in
          //    plain text) without dragging in the approval state machine.
          if (effectiveApproved) {
            const granted = path.resolve(String(rawPath || ''));
            if (tool.mutating) {
              decision.grantedPermissions.write.push(granted);
            } else {
              decision.grantedPermissions.read.push(granted);
            }
            continue;
          }
          if (tool.mutating) {
            return {
              ...decision,
              allowed: true,
              requiresApproval: true,
              reason: 'path_outside_workspace_requires_confirmation',
              requestedPath: String(rawPath || '').trim(),
              grantedPermissions: { read: [], write: [] }
            };
          }
          return {
            allowed: false,
            requiresApproval: false,
            reason: 'path_outside_workspace',
            requestedPath: String(rawPath || '').trim(),
            grantedPermissions: { read: [], write: [] }
          };
        }
        if (tool.mutating) {
          decision.grantedPermissions.write.push(resolved);
        } else {
          decision.grantedPermissions.read.push(resolved);
        }
      }
    }

    if (tool.mutating && !this.allowMutatingTools) {
      return {
        ...decision,
        allowed: false,
        reason: 'mutating_tools_disabled'
      };
    }

    if ((tool.requiresApproval || tool.mutating) && !effectiveApproved && !isDesktopTool(tool)) {
      return {
        ...decision,
        requiresApproval: true,
        reason: tool.mutating ? 'mutating_tool_requires_confirmation' : 'tool_requires_confirmation'
      };
    }

    if ((tool.requiresApproval || tool.mutating) && autoApproveAll && invocation.metadata?.approved !== true) {
      // Tell downstream callers the approval was synthesized by the
      // conversation-level flag rather than an explicit user click — useful
      // for audit logging.
      decision.autoApproved = true;
    }

    return decision;
  }
}

export default AssistantToolPolicyService;
