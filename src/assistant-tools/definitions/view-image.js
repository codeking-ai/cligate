export function createViewImageToolDefinition({ handlers }) {
  return {
    name: 'view_image',
    description: 'Read a local image from the workspace and return it as multimodal input content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        detail: { type: 'string', enum: ['low', 'high', 'original'] },
        maxBytes: { type: 'integer', minimum: 1024, maximum: 20971520 }
      },
      required: ['path']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'hosted',
    execute: handlers.viewImage
  };
}

export default createViewImageToolDefinition;
