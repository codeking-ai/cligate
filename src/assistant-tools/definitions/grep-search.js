export function createGrepSearchToolDefinition({ handlers }) {
  return {
    name: 'grep_search',
    description: 'Search file contents under a workspace path.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        caseSensitive: { type: 'boolean' },
        isRegex: { type: 'boolean' },
        before: { type: 'integer', minimum: 0, maximum: 20 },
        after: { type: 'integer', minimum: 0, maximum: 20 },
        limit: { type: 'integer', minimum: 1, maximum: 1000 }
      },
      required: ['pattern']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'hosted',
    execute: handlers.grepSearch
  };
}

export default createGrepSearchToolDefinition;
