export function createDesktopCaptureWindowToolDefinition({ handlers }) {
  return {
    name: 'desktop_capture_window',
    description: 'Screenshot the desktop, a specific window (windowHwnd), or an explicit pixel region. Set inline=true to get base64 data back inline (default). Use this when (a) a UIA selector fails and you need to SEE the actual UI, (b) the app does not expose accessibility metadata, or (c) you need to verify a desktop_click/set_value visually landed. Screenshots are stored under .tmp/desktop-control-agent/screenshots/.',
    inputSchema: {
      type: 'object',
      properties: {
        windowHwnd: { type: 'integer' },
        region: {
          oneOf: [
            {
              type: 'array',
              items: { type: 'integer' },
              minItems: 4,
              maxItems: 4
            },
            {
              type: 'object',
              properties: {
                x: { type: 'integer' },
                y: { type: 'integer' },
                w: { type: 'integer' },
                h: { type: 'integer' }
              }
            }
          ]
        },
        inline: { type: 'boolean' },
        inlineTarget: { type: 'string', enum: ['preview', 'full'] },
        previewWidth: { type: 'integer', minimum: 64, maximum: 4096 },
        leaseId: { type: 'string' }
      }
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.desktopCaptureWindow
  };
}

export default createDesktopCaptureWindowToolDefinition;
