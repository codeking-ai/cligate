export function createDesktopClickAtToolDefinition({ handlers }) {
  return {
    name: 'desktop_click_at',
    description: 'Click at a specific pixel coordinate. Use ONLY when UIA selectors keep failing AND you have just captured a screenshot that shows the target. PREFERRED workflow: take screenshot → use space:"preview" with x,y in preview pixels — the server tracks the most recent capture\'s preview→screen mapping so you do not need to pass previewWidth/previewHeight at all. For semantic clicks where the control IS in the UIA tree, prefer desktop_click_control. The response reports FOUR important diagnostic fields you must check before claiming success: (1) `moved` — did the cursor actually reach the target? false means Remote Desktop / ClipCursor / another process is reverting our move; the click was SKIPPED in that case (skipped_due_to_cursor=true, skipped_reason="cursor_did_not_move"). (2) `moved_to_actual` — where the cursor actually ended up. (3) `cursor_before` — Win32 cursor shape on hover; if shape="arrow" and the target is supposed to be a hyperlink like "自定义安装 >" in the Dingtalk installer, your coordinates are wrong, retry. (4) `cursor_after` — sample after the click. Set verifyHover=true to be defensive: when the cursor shape is arrow/wait/none/appstarting on hover, the click is SKIPPED proactively. Do NOT loop on a click that reports `moved:false` — that means input is being silently dropped (RDP) or UIPI (elevation gap); ask the user instead of retrying.',
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
        },
        verifyHover: {
          type: 'boolean',
          description: 'When true, skip the click if the cursor shape on hover is arrow / none / wait / appstarting (i.e. the OS reports the target is NOT an interactive element). Use this for hyperlink-style targets in ATL / DirectUI / web UIs where a hand cursor is the reliable interactivity signal. Default false — native Win32 buttons keep the cursor as arrow yet are clickable.'
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
