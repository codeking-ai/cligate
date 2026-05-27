export function createDesktopLaunchAppToolDefinition({ handlers }) {
  return {
    name: 'desktop_launch_app',
    description: 'Launch a desktop application. One of several equivalent ways to open an app for the user ("open Chrome", "start Feishu", etc.); pick whichever path reaches the goal fastest given current evidence. Equivalent alternatives include: inspect desktop_health.active_window first (if the foreground window IS already the target app, just proceed — nothing to launch), inspect desktop_list_windows (if the target is already running, prefer desktop_focus_window(hwnd)), or call run_shell_command with `start chrome` / `Start-Process chrome` (cmd/PowerShell ShellExecute, functionally equivalent to this tool). Reasonable choice; not a forced order. Probe note: do NOT use `where chrome` / `Get-Command chrome` / `Test-Path "C:\\Program Files\\...\\chrome.exe"` as an "is it installed" check before calling this — `where` and `Get-Command` only cover PATH, and almost every Windows desktop app (Chrome / Edge / Firefox / Feishu / WeChat / DingTalk / QQ / etc.) lives outside PATH under `Program Files\\...`, so those probes systematically lie. If you genuinely need to launch, pass `path` (preferred when you know an exact .lnk/.exe path) OR `query` (Windows Start-menu search — `query: "Chrome"` / `query: "飞书"` / `query: "微信"` all resolve through the Start index, no PATH lookup involved). After launching, follow with desktop_focus_window and desktop_wait_for_control before interacting. If launch fails with startfile_failed, retry with the alternative input shape (`path` ↔ `query`) or ask the user.',
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
