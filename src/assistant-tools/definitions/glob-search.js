export function createGlobSearchToolDefinition({ handlers }) {
  return {
    name: 'glob_search',
    description: 'Search workspace files by glob pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        cwd: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 2000 }
      },
      required: ['pattern']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'hosted',
    execute: handlers.globSearch
  };
}

export default createGlobSearchToolDefinition;
