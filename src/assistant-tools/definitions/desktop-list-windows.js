export function createDesktopListWindowsToolDefinition({ handlers }) {
  return {
    name: 'desktop_list_windows',
    description: 'List visible desktop windows (hwnd, title, class, pid). This is the authoritative answer to "is X running" — if the target app appears in this list it is running, no matter what `where X` / `Get-Command X` say (most desktop apps live outside PATH). Call this FIRST whenever you need to interact with an app whose exact window title you do not already know, after a window/control selector failed, or before deciding whether to call desktop_launch_app (if the app is already in this list, skip the launch and go straight to desktop_focus_window with its hwnd). The response gives you the canonical title strings you can plug into desktop_focus_window / desktop_find_control. Optional `title`+`match` filters narrow the list server-side.',
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
