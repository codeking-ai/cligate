export function createWriteFileToolDefinition({ handlers }) {
  return {
    name: 'write_file',
    description: 'Create or overwrite a UTF-8 text file in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        mode: { type: 'string', enum: ['overwrite', 'append'] }
      },
      required: ['path', 'content']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: true,
    requiresApproval: true,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.writeFile
  };
}

export default createWriteFileToolDefinition;
