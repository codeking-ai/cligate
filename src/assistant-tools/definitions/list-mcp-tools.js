export function createListMcpToolsToolDefinition({ handlers }) {
  return {
    name: 'list_mcp_tools',
    description: 'List normalized MCP tools for a configured server.',
    inputSchema: {
      type: 'object',
      properties: {
        serverName: { type: 'string' }
      },
      required: ['serverName']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'mcp',
    execute: handlers.listMcpTools
  };
}

export default createListMcpToolsToolDefinition;
