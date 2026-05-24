export function createListMcpResourcesToolDefinition({ handlers }) {
  return {
    name: 'list_mcp_resources',
    description: 'List resources exposed by a configured MCP server.',
    inputSchema: {
      type: 'object',
      properties: {
        serverName: { type: 'string' },
        cursor: { type: 'string' }
      },
      required: ['serverName']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'mcp',
    execute: handlers.listMcpResources
  };
}

export default createListMcpResourcesToolDefinition;
