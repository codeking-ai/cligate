export function createDesktopWaitForProcessToolDefinition({ handlers }) {
  return {
    name: 'desktop_wait_for_process',
    description: [
      'Block until a Windows process appears (or disappears), then return. Use this when you launched an installer / app via desktop_launch_app or run_shell_command and need to wait for it to actually start before you interact with it (or wait for it to finish before assuming the install is done).',
      '',
      'Probe is `tasklist /FI` under the hood — does NOT require admin, does NOT need a window to be visible. Pass `nameOrPid`: an executable name like "Feishu.exe" / "chrome.exe", or a numeric PID. Pass `untilState`:',
      '  - "appears" (default) — wait until the process is running.',
      '  - "disappears" — wait until the process is gone (use this after killing it, or to detect "installer finished and closed itself").',
      '',
      'Returns `{matched, timedOut, attempts, elapsedMs, details:{present, ...}}`. Cancellation: aborts immediately with code RUN_CANCELLED if the run is cancelled mid-wait.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      required: ['nameOrPid'],
      properties: {
        nameOrPid: {
          type: 'string',
          description: 'Process executable name including extension (e.g. "Feishu.exe", "chrome.exe", "Setup.exe") OR a numeric PID as a string.'
        },
        untilState: {
          type: 'string',
          enum: ['appears', 'disappears'],
          default: 'appears',
          description: 'Whether to wait for the process to START existing or to STOP existing.'
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
    execute: handlers.desktopWaitForProcess
  };
}

export default createDesktopWaitForProcessToolDefinition;
