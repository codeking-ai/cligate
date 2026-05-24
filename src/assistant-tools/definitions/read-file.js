export function createReadFileToolDefinition({ handlers }) {
  return {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        maxBytes: { type: 'integer', minimum: 1, maximum: 262144 }
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
    execute: handlers.readFile
  };
}

export default createReadFileToolDefinition;
