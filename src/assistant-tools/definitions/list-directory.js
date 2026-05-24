export function createListDirectoryToolDefinition({ handlers }) {
  return {
    name: 'list_directory',
    description: 'List files and directories under the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 1000 }
      }
    },
    outputSchema: {
      type: 'object'
    },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'hosted',
    execute: handlers.listDirectory
  };
}

export default createListDirectoryToolDefinition;
