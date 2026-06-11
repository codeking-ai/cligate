export function createDesktopCaptureWindowToolDefinition({ handlers }) {
  return {
    name: 'desktop_capture_window',
    description: 'Screenshot the desktop, a specific window (windowHwnd / windowTitle / windowClass), or an explicit pixel region. When you pass any window identifier WITHOUT a region, the agent auto-crops to that window\'s BoundingRectangle so small dialogs are not lost inside a 2560x1600 preview. AFTER this call: just use `space:"preview"` on desktop_click_at / desktop_move_mouse with x,y in the PREVIEW pixel grid you visually identified — the server now remembers the preview/region/screen relationship from this capture and resolves the math itself. You do NOT need to echo previewWidth/previewHeight back; if you do, they will be cross-checked against the server\'s record and the server\'s value wins. window_region={x,y,w,h} is also returned for advanced use with space:"region". Set inline=true to get base64 inline (default). Do NOT pass a placeholder region like {x:0,y:0,w:0,h:0} when you only have the window handle — leave region out entirely. To forward this screenshot on a channel, pass the returned `imageArtifactId` to send_message_to_channel — do NOT reconstruct or retype a file path.',
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
        leaseId: { type: 'string' },
        sessionId: { type: 'string' }
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
