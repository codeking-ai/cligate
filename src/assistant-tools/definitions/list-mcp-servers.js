export function createListMcpServersToolDefinition({ handlers }) {
  return {
    name: 'list_mcp_servers',
    description: 'List configured MCP servers visible to the assistant-tools host.',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'mcp',
    execute: handlers.listMcpServers
  };
}

export default createListMcpServersToolDefinition;
