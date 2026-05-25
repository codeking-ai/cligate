export function createDesktopListWindowsToolDefinition({ handlers }) {
  return {
    name: 'desktop_list_windows',
    description: 'List visible desktop windows (hwnd, title, class, pid). Call this FIRST whenever you need to interact with an app whose exact window title you do not already know, or after a window/control selector failed — the response gives you the canonical title strings you can plug into desktop_focus_window / desktop_find_control. Optional `title`+`match` filters narrow the list server-side.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        match: {
          type: 'string',
          enum: ['contains', 'exact', 'regex']
        }
      }
    },
    outputSchema: {
      type: 'object'
    },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'hosted',
    execute: handlers.desktopListWindows
  };
}

export default createDesktopListWindowsToolDefinition;
