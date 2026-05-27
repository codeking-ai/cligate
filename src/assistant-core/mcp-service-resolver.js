import mcpConnectionManager from '../mcp/index.js';

export function resolveEnabledMcpService() {
  return mcpConnectionManager?.hasEnabledServers?.() ? mcpConnectionManager : null;
}

export default resolveEnabledMcpService;
