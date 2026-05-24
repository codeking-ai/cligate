export function createCallMcpToolDefinition({ handlers }) {
  return {
    name: 'call_mcp_tool',
    description: 'Call a normalized MCP tool by server/tool identity or namespaced tool name.',
    inputSchema: {
      type: 'object',
      properties: {
        serverName: { type: 'string' },
        toolName: { type: 'string' },
        namespacedToolName: { type: 'string' },
        arguments: { type: 'object' },
        metadata: { type: 'object' }
      }
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: true,
    requiresApproval: true,
    parallelSafe: false,
    source: 'mcp',
    execute: handlers.callMcpTool
  };
}

export default createCallMcpToolDefinition;
