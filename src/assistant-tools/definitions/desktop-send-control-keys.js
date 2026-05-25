export function createDesktopSendControlKeysToolDefinition({ handlers }) {
  return {
    name: 'desktop_send_control_keys',
    description: 'Send a key sequence to a matched control (sets focus to it first). Use UIA SendKeys syntax: `{Enter}`, `{Tab}`, `^c` (Ctrl+C), `^v`, `%{F4}` (Alt+F4). For pasting/setting free-form text into an input, prefer desktop_set_control_value instead — keystrokes are subject to IME and focus flakiness.',
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
        keys: { type: 'string' }
      },
      required: ['keys']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: true,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.desktopSendControlKeys
  };
}

export default createDesktopSendControlKeysToolDefinition;
