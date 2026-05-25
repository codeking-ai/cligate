export function createDesktopWaitForControlToolDefinition({ handlers }) {
  return {
    name: 'desktop_wait_for_control',
    description: 'Block until a matched control appears (default 4 s, override with timeoutMs ≤ 120000). Use AFTER desktop_launch_app while the app is still rendering, or after a click that triggers a new dialog/page. Prefer this over a fixed sleep — it returns as soon as the control is present instead of always waiting the full timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        windowHwnd: { type: 'integer' },
        windowTitle: { type: 'string' },
        windowClass: { type: 'string' },
        windowMatch: { type: 'string', enum: ['contains', 'exact', 'regex'] },
        controlType: { type: 'string' },
        name: { type: 'string' },
        nameMatch: { type: 'string', enum: ['contains', 'exact', 'regex'] },
        automationId: { type: 'string' },
        className: { type: 'string' },
        searchDepth: { type: 'integer', minimum: 1, maximum: 64 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 }
      }
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'hosted',
    execute: handlers.desktopWaitForControl
  };
}

export default createDesktopWaitForControlToolDefinition;
