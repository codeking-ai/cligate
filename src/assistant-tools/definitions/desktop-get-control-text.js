export function createDesktopGetControlTextToolDefinition({ handlers }) {
  return {
    name: 'desktop_get_control_text',
    description: 'Read the visible text/value of a matched control (UIA ValuePattern → TextPattern → Name fallback). For reading a chat-app reply, find the latest Text or Document control inside the conversation pane and call this. If the response stays empty, the control may still be rendering — use desktop_wait_for_control with a more specific selector first.',
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
    execute: handlers.desktopGetControlText
  };
}

export default createDesktopGetControlTextToolDefinition;
