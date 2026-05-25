export function createDesktopFocusWindowToolDefinition({ handlers }) {
  return {
    name: 'desktop_focus_window',
    description: 'Bring a desktop window to the foreground by hwnd (preferred — stable) or by title/match. If you do not yet have the hwnd, call desktop_list_windows first to obtain it. Required before sending keyboard input via desktop_send_control_keys to a control that depends on focus. If it fails with FocusFailed, the OS focus-stealing protection rejected the request — retry once, then ask the user to click the window.',
    inputSchema: {
      type: 'object',
      properties: {
        hwnd: { type: 'integer' },
        title: { type: 'string' },
        match: { type: 'string', enum: ['contains', 'exact', 'regex'] }
      }
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: true,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.desktopFocusWindow
  };
}

export default createDesktopFocusWindowToolDefinition;
