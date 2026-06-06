// Desktop-capture SETUP service (Windows).
//
// Backs the dashboard "Desktop control" toggle on the Assistant page. It does
// NOT capture the screen itself — it configures the machine ONCE so that screen
// capture + input work reliably in all three scenarios (physical monitor, HDMI
// dummy display, Remote Desktop, including AFTER an RDP disconnect):
//   - the desktop agent auto-starts in the logged-in session,
//   - on RDP disconnect the session is bounced back to the console (stays
//     unlocked),
//   - (opt-in) the user auto-logs-in to the console so a headless box has a
//     live desktop with nobody connected,
//   - never lock / never sleep / no screensaver.
//
// The heavy lifting lives in scripts/desktop-agent/setup-desktop-capture.ps1.
// Enabling REQUIRES admin, so we launch that script ELEVATED via UAC
// (Start-Process -Verb RunAs). The UAC consent — and, for the auto-login
// option, the Windows password prompt — appear ON THE HOST's screen
// (console / Remote Desktop); the password never travels through CliGate.
//
// Because the elevated process is detached, enable()/disable() only report
// whether elevation was launched; the dashboard polls getStatus() (which reads
// the scheduled tasks + auto-login flag) to confirm the result.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const SETUP_SCRIPT = path.resolve(moduleDir, '..', '..', 'scripts', 'desktop-agent', 'setup-desktop-capture.ps1');

function isWindows() {
  return process.platform === 'win32';
}

function runPowerShell(args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
        windowsHide: true
      });
    } catch (error) {
      resolve({ code: -1, out: '', err: String(error?.message || error) });
      return;
    }
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ code: -1, out, err: `${err}\n[timeout after ${timeoutMs}ms]` });
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(error?.message || error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

// Is the CURRENT CliGate process running with admin rights? Configuring
// scheduled SYSTEM tasks + auto-login requires this. A non-admin process cannot
// silently elevate (Windows by design), so when CliGate is not elevated we must
// tell the user to run the setup elevated themselves rather than silently fail.
export async function isElevated() {
  if (!isWindows()) return false;
  const { out } = await runPowerShell([
    '-Command',
    '[bool](([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))'
  ], { timeoutMs: 8000 });
  return String(out || '').trim().toLowerCase() === 'true';
}

// The exact command the user can paste into an elevated PowerShell to do the
// setup by hand (always works — the UAC shows because THEY launch the admin
// shell). `-SkipAutoLogin` unless they explicitly want reboot-survival.
export function manualCommand({ autoLogin = false } = {}) {
  return `powershell -ExecutionPolicy Bypass -File "${SETUP_SCRIPT}"${autoLogin ? '' : ' -SkipAutoLogin'}`;
}

export async function getStatus() {
  if (!isWindows()) {
    return { supported: false, enabled: false, platform: process.platform };
  }
  const psStatus = [
    "$ErrorActionPreference='SilentlyContinue'",
    "function TaskExists($n){ return [bool](Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) }",
    "$auto = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon').AutoAdminLogon",
    "$o = [ordered]@{ agentTask = (TaskExists 'CliGateDesktopAgent'); reconnectTask = (TaskExists 'CliGateReconnectConsole'); serverTask = (TaskExists 'CliGateServer'); autoLogin = ($auto -eq '1') }",
    "$o | ConvertTo-Json -Compress"
  ].join('; ');
  const { out } = await runPowerShell(['-Command', psStatus], { timeoutMs: 15000 });
  let details = {};
  try {
    details = JSON.parse(String(out || '').trim() || '{}');
  } catch {
    details = {};
  }
  // "enabled" = the capability that fixes the common case (works while/after RDP
  // and on the console): the agent task plus the reconnect-to-console task. The
  // auto-login flag is a separate, opt-in reboot-survival extra.
  const enabled = details.agentTask === true && details.reconnectTask === true;
  const elevated = await isElevated();
  return { supported: true, enabled, elevated, details, command: manualCommand({ autoLogin: false }) };
}

// Run the setup script DIRECTLY (we are already elevated) and capture the real
// exit code + output. This is reliable — unlike Start-Process -Verb RunAs from a
// background server process, which gives no visible UAC and silently fails.
async function runScriptDirect(scriptArgs, { timeoutMs = 180000 } = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SETUP_SCRIPT, ...scriptArgs];
  const { code, out, err } = await runPowerShell(args, { timeoutMs });
  return { code, tail: String(`${out || ''}\n${err || ''}`).trim().slice(-800) };
}

export async function enable({ autoLogin = false } = {}) {
  if (!isWindows()) {
    return { ok: false, supported: false, error: 'desktop-capture setup is Windows-only' };
  }
  const elevated = await isElevated();
  if (!elevated) {
    // Cannot configure the machine without admin, and we will not pretend to.
    // Tell the user exactly how to do it (works because THEY launch the admin
    // shell, so the UAC prompt actually appears).
    return {
      ok: false,
      needsAdmin: true,
      command: manualCommand({ autoLogin }),
      error: 'CliGate is not running as administrator, so it cannot set up desktop control. Restart CliGate from an elevated PowerShell, OR run the shown command once in an elevated PowerShell on this PC.'
    };
  }
  // Elevated: run the setup in-process (no UAC needed). The headless server
  // cannot type the auto-login password into Read-Host, so this path always
  // does the no-password tier (-SkipAutoLogin); reboot-survival auto-login is
  // done via the manual command (which prompts for the password on the host).
  const { code, tail } = await runScriptDirect(['-SkipAutoLogin']);
  const status = await getStatus();
  if (status.enabled) {
    return { ok: true, ranDirect: true, autoLoginHint: autoLogin ? manualCommand({ autoLogin: true }) : '' };
  }
  return { ok: false, ranDirect: true, code, error: 'setup ran but the tasks were not created; see the tail', tail };
}

export async function disable() {
  if (!isWindows()) {
    return { ok: false, supported: false, error: 'desktop-capture setup is Windows-only' };
  }
  const elevated = await isElevated();
  if (!elevated) {
    return {
      ok: false,
      needsAdmin: true,
      command: `powershell -ExecutionPolicy Bypass -File "${SETUP_SCRIPT}" -Uninstall`,
      error: 'CliGate is not running as administrator. Run the shown command once in an elevated PowerShell to disable.'
    };
  }
  const { code, tail } = await runScriptDirect(['-Uninstall']);
  return { ok: code === 0, ranDirect: true, code, tail };
}

export default { getStatus, enable, disable, isElevated, manualCommand };
