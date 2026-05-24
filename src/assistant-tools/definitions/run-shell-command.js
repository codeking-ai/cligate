export function createRunShellCommandToolDefinition({ handlers }) {
  return {
    name: 'run_shell_command',
    description: 'Run a shell command inside the workspace and capture stdout/stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 },
        maxBytes: { type: 'integer', minimum: 256, maximum: 1048576 }
      },
      required: ['command']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: true,
    requiresApproval: true,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.runShellCommand
  };
}

export default createRunShellCommandToolDefinition;
