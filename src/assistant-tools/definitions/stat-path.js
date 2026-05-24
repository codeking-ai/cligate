export function createStatPathToolDefinition({ handlers }) {
  return {
    name: 'stat_path',
    description: 'Return file or directory metadata for a workspace path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' }
      },
      required: ['path']
    },
    outputSchema: {
      type: 'object'
    },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'hosted',
    execute: handlers.statPath
  };
}

export default createStatPathToolDefinition;
