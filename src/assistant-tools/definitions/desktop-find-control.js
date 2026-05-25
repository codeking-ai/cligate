export function createDesktopFindControlToolDefinition({ handlers }) {
  return {
    name: 'desktop_find_control',
    description: 'Find a single UI Automation control inside a target desktop window. Provide one window selector (windowHwnd, windowTitle, or windowClass) plus optional control selectors (controlType like Edit/Button/Text, name with nameMatch, automationId, className). If you get "control not found", first call desktop_capture_window to see the actual UI, then either broaden the selector (drop name, omit className) or switch controlType. For listing many candidates at once, use desktop_find_all_controls instead. IMPORTANT: many apps bury controls deep — default searchDepth=32 is usually right; do NOT lower it to 6/8 (you will miss things). App-specific tips: Chrome address bar is controlType="Edit" name="Address and search bar" (English Chrome, same string across system locales). When UIA selectors keep failing, switch strategy entirely: desktop_focus_window + desktop_hotkey(["ctrl","l"]) + desktop_type_text + desktop_press_key("enter") opens a URL in any browser without needing any control match.',
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
    execute: handlers.desktopFindControl
  };
}

export default createDesktopFindControlToolDefinition;
