export function createDesktopLaunchAppToolDefinition({ handlers }) {
  return {
    name: 'desktop_launch_app',
    description: 'Launch a desktop application. Pass `path` (preferred, e.g. an absolute .lnk/.exe path) OR `query` (Windows Start-menu search fallback). After launching, the app needs a moment to render — typically follow with desktop_focus_window and desktop_wait_for_control before interacting. If launch fails with startfile_failed, ask the user for the correct path or retry with `query`.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        query: { type: 'string' },
        leaseId: { type: 'string' }
      }
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.desktopLaunchApp
  };
}

export default createDesktopLaunchAppToolDefinition;
