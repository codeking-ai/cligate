export function createDesktopSetControlValueToolDefinition({ handlers }) {
  return {
    name: 'desktop_set_control_value',
    description: 'Set the value of a matched input control (text box, search field) via UIA ValuePattern — replaces existing content. Prefer this over typing keystrokes because it does not depend on focus, clipboard, or IME state. Use the same window/control selectors as desktop_find_control. To trigger submission afterwards, follow with desktop_send_control_keys keys="{Enter}".',
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
        text: { type: 'string' }
      },
      required: ['text']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: true,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.desktopSetControlValue
  };
}

export default createDesktopSetControlValueToolDefinition;
