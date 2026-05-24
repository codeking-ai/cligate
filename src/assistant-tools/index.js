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

export function createBuiltinAssistantToolRegistry({
  workspaceRoot = process.cwd(),
  mcpService = null
} = {}) {
  const workspaceGuard = new WorkspaceGuard({ workspaceRoot });
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
