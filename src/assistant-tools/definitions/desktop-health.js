export function createDesktopHealthToolDefinition({ handlers }) {
  return {
    name: 'desktop_health',
    description: 'Probe the desktop-agent companion service. Returns screen size, cursor position, and the currently active window. Call this FIRST when any desktop_* tool returns AgentUnreachable, or before a long sequence of UI actions to confirm the agent is alive. Has no side effects.',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    outputSchema: {
      type: 'object'
    },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'hosted',
    execute: handlers.desktopHealth
  };
}

export default createDesktopHealthToolDefinition;
