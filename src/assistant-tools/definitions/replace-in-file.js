export function createReplaceInFileToolDefinition({ handlers }) {
  return {
    name: 'replace_in_file',
    description: 'Replace text in a UTF-8 workspace file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        pattern: { type: 'string' },
        replacement: { type: 'string' },
        isRegex: { type: 'boolean' },
        replaceAll: { type: 'boolean' },
        caseSensitive: { type: 'boolean' },
        maxReplacements: { type: 'integer', minimum: 0, maximum: 100000 }
      },
      required: ['path']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: true,
    requiresApproval: true,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.replaceInFile
  };
}

export default createReplaceInFileToolDefinition;
