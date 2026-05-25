export function createDesktopFindAllControlsToolDefinition({ handlers }) {
  return {
    name: 'desktop_find_all_controls',
    description: 'List every UIA control inside a window that matches the given selectors (up to maxItems, default 50). Use this to enumerate options — e.g. all Buttons in a dialog, all ListItems in a result list, or to dump candidate Edits when you do not know the exact name. Cheaper than desktop_capture_window for discovery when the app does expose a11y. IMPORTANT: pass searchDepth=32 (the maximum useful default) unless you have a specific reason to limit. Apps like Chrome bury Edit/Document/Toolbar controls 12+ levels deep — a shallow searchDepth=6 or 8 will silently return count:0 and you will conclude the control does not exist when it does. When find_all returns empty, the right next step is desktop_capture_window (to look at the screen visually) or switch strategy to desktop_hotkey + desktop_type_text + desktop_press_key entirely.',
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
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
        maxItems: { type: 'integer', minimum: 1, maximum: 200 }
      }
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'hosted',
    execute: handlers.desktopFindAllControls
  };
}

export default createDesktopFindAllControlsToolDefinition;
