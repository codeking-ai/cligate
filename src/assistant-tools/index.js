import { homedir } from 'node:os';
import path from 'node:path';
import AssistantToolsRegistry from './registry.js';
import WorkspaceGuard from './workspace-guard.js';
import AssistantToolPolicyService from './policy.js';
import AssistantToolsExecutor from './executor.js';
import runAssistantToolLoop from './loop.js';
import createBuiltinAssistantToolDefinitions from './definitions/index.js';
import AssistantMcpService, {
  buildNamespacedMcpToolName,
  parseNamespacedMcpToolName
} from './mcp-service.js';

// The CliGate config dir is the software's own home (skills, stores, settings).
// It lives OUTSIDE any user workspace (usually a different drive), so binding
// file tools to the workspace root alone made the assistant unable to read its
// own skill files (`Path is outside the workspace`). It is always fully
// read+write — no per-call approval — independent of the run's cwd. Honors the
// same CLIGATE_CONFIG_DIR override the stores use (and tests' temp redirect).
export function resolveCligateConfigDir() {
  const override = String(process.env.CLIGATE_CONFIG_DIR || '').trim();
  return override || path.join(homedir(), '.cligate');
}

export function createBuiltinAssistantToolRegistry({
  workspaceRoot = process.cwd(),
  mcpService = null
} = {}) {
  const workspaceGuard = new WorkspaceGuard({
    workspaceRoot,
    extraWriteRoots: [resolveCligateConfigDir()]
  });
  const registry = new AssistantToolsRegistry();
  for (const definition of createBuiltinAssistantToolDefinitions({ workspaceGuard, mcpService })) {
    registry.register(definition);
  }
  return {
    registry,
    workspaceGuard
  };
}

export {
  AssistantToolsRegistry,
  WorkspaceGuard,
  AssistantToolPolicyService,
  AssistantToolsExecutor,
  AssistantMcpService,
  runAssistantToolLoop,
  createBuiltinAssistantToolDefinitions,
  buildNamespacedMcpToolName,
  parseNamespacedMcpToolName
};

export default createBuiltinAssistantToolRegistry;
