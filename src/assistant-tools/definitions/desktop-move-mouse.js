export function createDesktopMoveMouseToolDefinition({ handlers }) {
  return {
    name: 'desktop_move_mouse',
    description: 'Move the cursor to a specific pixel coordinate WITHOUT clicking. Mostly used to position the cursor over a target area before desktop_scroll (which scrolls at the cursor location), or to hover over a control to trigger a tooltip before screenshotting. Same `space` semantics as desktop_click_at — prefer space="preview" with coordinates read from a recent desktop_capture_window.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        space: {
          type: 'string',
          enum: ['screen', 'normalized', 'preview', 'region']
        },
        previewWidth: { type: 'integer' },
        previewHeight: { type: 'integer' },
        region: {
          oneOf: [
            { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 },
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
        }
      },
      required: ['x', 'y']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: true,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.desktopMoveMouse
  };
}

export default createDesktopMoveMouseToolDefinition;
