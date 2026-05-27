export function createDesktopHealthToolDefinition({ handlers }) {
  return {
    name: 'desktop_health',
    description: 'Probe the desktop-agent companion service. Returns screen size, cursor position, the currently active window, plus several critical diagnostic fields. KEY USE CASE: when the user asks to "open X" / "launch Y" / "is Z running", call this FIRST and read `active_window.title` and `active_window.class` — if the foreground window already belongs to the target app (e.g. `active_window.title` contains "Chrome"), the app is already running and already focused, just proceed to the next step instead of trying to launch or search for it. The other diagnostic fields you must also inspect before any sequence of clicks: (1) `elevated` (bool) and `integrity_level` ("high"/"medium"/...): if elevated=false and the target is a UAC-elevated installer, every input is dropped by Windows UIPI — stop clicking, tell the user to run `scripts/desktop-agent/install-elevated-task.ps1` from an Administrator PowerShell. (2) `remote_session` (bool): true means the agent runs inside an RDP session — SetCursorPos calls fight the client\'s pointer sync, desktop_move_mouse will frequently report moved=false; tell the user precision pointer control is unreliable over RDP and suggest local execution. (3) `active_window`: confirms which window is in front, so you click the right one AND so you know whether a "please open X" request is already satisfied. Call this FIRST when any desktop_* tool returns AgentUnreachable, or before a long sequence of UI actions to confirm the agent is alive. Has no side effects.',
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
