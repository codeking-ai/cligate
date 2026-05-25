export function createDesktopClickAtToolDefinition({ handlers }) {
  return {
    name: 'desktop_click_at',
    description: 'Click at a specific pixel coordinate. Use ONLY when UIA selectors keep failing AND you have just captured a screenshot that shows the target. The screenshot returned by desktop_capture_window gives you both full and preview dimensions — pass `space:"preview"` with the preview-pixel coordinates (preferred, simpler) OR `space:"screen"` with full-resolution coordinates. Always: take screenshot → identify target visually → click. Do NOT guess coordinates. For semantic clicks where the control IS in the UIA tree, prefer desktop_click_control.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Horizontal coordinate in the chosen `space`.' },
        y: { type: 'number', description: 'Vertical coordinate in the chosen `space`.' },
        space: {
          type: 'string',
          enum: ['screen', 'normalized', 'preview', 'region'],
          description: 'Coordinate space. "screen" = raw pixels on the physical monitor. "preview" = pixels in the downscaled preview returned by desktop_capture_window (must pass previewWidth then). "normalized" = 0..1 fractions. "region" = relative to an explicit region.'
        },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
        clicks: { type: 'integer', minimum: 1, maximum: 5, description: 'Number of clicks (1 = single, 2 = double).' },
        previewWidth: { type: 'integer', description: 'Required when space="preview" — pass the previewWidth returned by the matching desktop_capture_window call.' },
        previewHeight: { type: 'integer', description: 'Optional when space="preview" — overrides aspect-ratio derivation.' },
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
          ],
          description: 'Required when space="region" — the region the coordinates are relative to.'
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
    execute: handlers.desktopClickAt
  };
}

export default createDesktopClickAtToolDefinition;
