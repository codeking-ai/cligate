export function createReadMcpResourceToolDefinition({ handlers }) {
  return {
    name: 'read_mcp_resource',
    description: 'Read a resource exposed by a configured MCP server.',
    inputSchema: {
      type: 'object',
      properties: {
        serverName: { type: 'string' },
        uri: { type: 'string' }
      },
      required: ['serverName', 'uri']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'mcp',
    execute: handlers.readMcpResource
  };
}

export default createReadMcpResourceToolDefinition;
