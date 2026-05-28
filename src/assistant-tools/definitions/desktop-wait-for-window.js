export function createDesktopWaitForWindowToolDefinition({ handlers }) {
  return {
    name: 'desktop_wait_for_window',
    description: [
      'Block until a desktop window matching `title` becomes visible, then return its hwnd/title/class/pid so you can immediately call desktop_focus_window or desktop_find_control against it.',
      '',
      'Use this whenever you trigger an action that opens a NEW window asynchronously — installer wizard pops up, app finishes booting, OS dialog appears. Without it you race the OS: focus_window will fail with "window not found" if you call it 200ms too early.',
      '',
      'Matching: same semantics as desktop_list_windows — `title` is the substring to look for, `windowMatch` picks "contains" (default), "exact", or "regex". Returns the FIRST matching window. Cancellation: aborts immediately with code RUN_CANCELLED if the run is cancelled mid-wait.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: {
          type: 'string',
          description: 'Substring of the desired window title, e.g. "飞书 安装" / "Feishu" / "Setup".'
        },
        windowMatch: {
          type: 'string',
          enum: ['contains', 'exact', 'regex'],
          default: 'contains'
        },
        timeoutMs: {
          type: 'integer',
          minimum: 250,
          maximum: 600000,
          default: 60000
        },
        pollMs: {
          type: 'integer',
          minimum: 250,
          maximum: 10000,
          default: 1500
        }
      }
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.desktopWaitForWindow
  };
}

export default createDesktopWaitForWindowToolDefinition;
