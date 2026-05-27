export function createDesktopMoveMouseToolDefinition({ handlers }) {
  return {
    name: 'desktop_move_mouse',
    description: 'Move the cursor to a specific pixel coordinate WITHOUT clicking. ALWAYS check the response\'s `moved` field — true means the cursor actually reached the target; false means Remote Desktop cursor sync / ClipCursor / multi-monitor coords are blocking us, and any subsequent click would land on the WRONG element (so do NOT click — surface this to the user and stop the retry loop). `moved_to_actual` is the position GetCursorPos read back. Also returns `cursor` with the Win32 cursor SHAPE at the new position (arrow / hand / ibeam / wait / ...) — use this as your "is this position actually interactive?" probe BEFORE issuing desktop_click_at. shape="hand" on hover is the canonical signal that the target is a clickable hyperlink / web-style button (Dingtalk installer\'s "自定义安装>", WeChat sidebar items, etc.). shape="arrow" plus is_clickable_hint=false means you missed — adjust coordinates and move again. Same `space` semantics as desktop_click_at — prefer space="preview" with coordinates read from a recent desktop_capture_window; the server resolves the preview→screen mapping itself. Also useful before desktop_scroll (which scrolls at the cursor location).',
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
