export function createDesktopClickControlToolDefinition({ handlers }) {
  return {
    name: 'desktop_click_control',
    description: 'Click/invoke a matched control via UIA InvokePattern (semantic — does not move the mouse). Same window/control selectors as desktop_find_control. If "control not found", use desktop_find_all_controls or desktop_capture_window to discover what is actually on screen rather than guessing more selectors.',
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
    mutating: true,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.desktopClickControl
  };
}

export default createDesktopClickControlToolDefinition;
