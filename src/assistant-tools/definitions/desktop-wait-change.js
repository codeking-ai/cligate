export function createDesktopWaitChangeToolDefinition({ handlers }) {
  return {
    name: 'desktop_wait_change',
    description: 'After a click / type / hotkey, verify the UI actually responded by sampling the screen and comparing pixel signatures. Call this right after any desktop_click_at / desktop_click_control / desktop_type_text when you expect the UI to change but cannot tell from a second screenshot alone — for example clicking an ATL / DirectUI installer that does not expose UIA controls. Returns changed=false when the region looks identical to the moment the call started, which usually means UIPI silently dropped the input (target window is elevated and the agent is not), or the click landed outside the hit-test bounds. Prefer scoping with windowHwnd or an explicit region so background animations elsewhere do not falsely report "changed".',
    inputSchema: {
      type: 'object',
      properties: {
        windowHwnd: { type: 'integer' },
        windowTitle: { type: 'string' },
        windowClass: { type: 'string' },
        region: {
          type: 'object',
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            w: { type: 'integer' },
            h: { type: 'integer' }
          }
        },
        timeoutMs: { type: 'integer', minimum: 50, maximum: 15000, default: 1500 },
        pollMs: { type: 'integer', minimum: 50, maximum: 2000, default: 200 },
        threshold: {
          type: 'number',
          minimum: 0,
          maximum: 255,
          default: 2.0,
          description: 'Mean absolute per-pixel grayscale difference (0-255) above which the region is considered changed.'
        },
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
    execute: handlers.desktopWaitChange
  };
}

export default createDesktopWaitChangeToolDefinition;
