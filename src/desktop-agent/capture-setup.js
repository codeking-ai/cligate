// Desktop MACHINE-PREPARATION service (Windows).
//
// Backs the dashboard "Machine preparation (advanced)" surface on the Assistant
// page. It does NOT capture the screen, and it does NOT auto-start any service.
// Desktop control itself is a CliGate-OWNED runtime capability (the agent lives
// and dies with CliGate). This service only does the *machine-level* Windows
// preparation that headless/remote desktop use requires:
//   - on RDP disconnect the (disconnected) session is bounced back to the
//     console so the HDMI dummy / physical monitor keeps a live, unlocked
//     desktop — RACE-SAFE: it never blocks an incoming/active RDP connection,
//   - never lock / never sleep / no screensaver,
//   - (opt-in) auto-login the user to the console so a headless box has a live
//     desktop with nobody connected.
//
// It also DETECTS and REMOVES the legacy auto-start tasks (CliGateDesktopAgent,
// CliGateServer) that used to bring the agent/CliGate up before the user opened
// CliGate — see removeLegacyTasks().
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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const SETUP_SCRIPT_RAW = path.resolve(moduleDir, '..', '..', 'scripts', 'desktop-agent', 'setup-desktop-capture.ps1');
// In a packaged Electron build the scripts live in app.asar.unpacked (asarUnpack),
// because PowerShell cannot execute a file inside the asar virtual filesystem.
// CliGate invokes this script INTERNALLY — the user never finds or runs it.
const SETUP_SCRIPT = SETUP_SCRIPT_RAW.includes('app.asar')
  ? SETUP_SCRIPT_RAW.replace('app.asar', 'app.asar.unpacked')
  : SETUP_SCRIPT_RAW;

// Elevation-independent "prepared" marker the setup script writes (elevated) in
// the world-readable ProgramData dir. CliGateReconnectConsole runs as SYSTEM and
// a SYSTEM task is invisible to a non-elevated Get-ScheduledTask, so when CliGate
// is NOT elevated the task probe alone would report prepared:false and re-prompt
// for admin on every restart. Reading this flag with plain fs (no elevation, no
// PowerShell) keeps the "set up once" contract regardless of how CliGate runs.
const PREPARED_MARKER = process.platform === 'win32'
  ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'CliGate', 'desktop-prepared.flag')
  : '';

// Bump whenever the bundled machine-prep (setup-desktop-capture.ps1 /
// reconnect-console.ps1) changes in a way that MUST be redeployed to machines
// that are already "prepared". The setup script stamps this number into the
// marker; a machine whose marker version is lower is treated as NOT fully
// prepared, so the next enable re-runs the prep (one UAC consent, or silent when
// elevated) and the fixed worker lands in ProgramData. Without this, an
// already-prepared machine would keep running an outdated/buggy worker forever.
// MUST stay in sync with $preparedVersion in setup-desktop-capture.ps1.
//   v2: fix qwinsta parsing of the blank-SESSIONNAME disconnected-session row
//       (the reconnect-to-console bounce silently never ran before this).
const PREPARED_VERSION = 2;

// Version stamped in the marker (0 = absent / legacy unversioned marker).
function preparedMarkerVersion() {
  try {
    if (!PREPARED_MARKER || !existsSync(PREPARED_MARKER)) return 0;
    const match = readFileSync(PREPARED_MARKER, 'utf8').match(/version\s*=\s*(\d+)/i);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

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

// Command to remove ONLY the legacy auto-start tasks (CliGateDesktopAgent +
// CliGateServer) — the ones that used to start the agent/CliGate before the
// user opened CliGate.
export function removeLegacyCommand() {
  return `powershell -ExecutionPolicy Bypass -File "${SETUP_SCRIPT}" -RemoveLegacyTasks`;
}

export function uninstallCommand() {
  return `powershell -ExecutionPolicy Bypass -File "${SETUP_SCRIPT}" -Uninstall`;
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
  // "prepared" = the machine-level capability that keeps the desktop alive for
  // headless/remote use: the race-safe reconnect-to-console task. It deliberately
  // does NOT depend on any auto-start task — desktop control is CliGate-owned now.
  // The SYSTEM-registered task is invisible to a non-elevated probe, so the
  // authoritative, elevation-independent signal is the versioned marker the
  // setup writes: prepared only when its version is current. A lower/absent
  // version means a worker fix needs (re)deploying, so the next enable re-runs.
  const prepared = preparedMarkerVersion() >= PREPARED_VERSION;
  // Legacy auto-start tasks: these bring the agent/CliGate up BEFORE the user
  // opens CliGate (and the agent task made the RDP-connect race worse). Surface
  // them so the dashboard can warn + offer one-click removal.
  const legacy = {
    present: details.agentTask === true || details.serverTask === true,
    agentTask: details.agentTask === true,
    serverTask: details.serverTask === true
  };
  const elevated = await isElevated();
  return {
    supported: true,
    prepared,
    enabled: prepared, // back-compat alias for the existing dashboard toggle
    elevated,
    details,
    legacy,
    command: manualCommand({ autoLogin: false }),
    removeLegacyCommand: removeLegacyCommand(),
    uninstallCommand: uninstallCommand()
  };
}

// Run the setup script DIRECTLY (we are already elevated) and capture the real
// exit code + output. This is reliable — unlike Start-Process -Verb RunAs from a
// background server process, which gives no visible UAC and silently fails.
async function runScriptDirect(scriptArgs, { timeoutMs = 180000 } = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SETUP_SCRIPT, ...scriptArgs];
  const { code, out, err } = await runPowerShell(args, { timeoutMs });
  return { code, tail: String(`${out || ''}\n${err || ''}`).trim().slice(-800) };
}

// Wrap a string as a PowerShell single-quoted literal (escape embedded quotes).
function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Launch the machine-prep script ELEVATED via a Windows UAC consent prompt.
// CliGate runs inside the user's INTERACTIVE desktop session, so the consent
// dialog (drawn by the system on the secure desktop) appears on the host's
// screen — console or Remote Desktop — and the user clicks "Yes" once. The
// outer powershell is non-interactive/hidden; that does NOT suppress the UAC
// consent (window visibility and -NonInteractive are unrelated to consent.exe).
//
// We do NOT -Wait: the elevated child is a separate process whose exit code we
// cannot read across the elevation boundary, so the dashboard confirms the
// result by polling getStatus().prepared. We still capture the LAUNCHER's own
// stdout so a cancelled consent ("operation was canceled by the user") is
// logged rather than looking like a silent success. Returns immediately so the
// HTTP request never blocks on the human responding to UAC.
//
// (The historical "RunAs silently fails" note above was the chicken-and-egg of
// trying to elevate while the session was already locked/disconnected — i.e.
// the very state this feature exists to prevent. When the user enables this
// while connected and at the desktop, the consent shows.)
function launchElevatedSetup(scriptArgs) {
  const inner = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', SETUP_SCRIPT, ...scriptArgs];
  const innerList = inner.map(psSingleQuote).join(',');
  const psCommand = `try { Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList ${innerList}; Write-Output 'launched' } catch { Write-Output ('declined:' + $_.Exception.Message) }`;
  let child;
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand], {
      windowsHide: true
    });
  } catch (error) {
    return { launched: false, error: String(error?.message || error) };
  }
  let out = '';
  child.stdout?.on('data', (chunk) => { out += chunk.toString(); });
  child.on('close', () => {
    const text = String(out || '').trim();
    if (text.startsWith('declined')) {
      logger.warn?.(`[desktop-capture] one-time setup UAC consent declined or failed: ${text.slice('declined:'.length).trim()}`);
    } else {
      logger.info?.('[desktop-capture] one-time machine preparation launched via UAC consent');
    }
  });
  child.on('error', (error) => {
    logger.warn?.(`[desktop-capture] elevated setup launcher error: ${String(error?.message || error)}`);
  });
  return { launched: true, pendingConsent: true };
}

// The one-time machine preparation behind the single "Desktop control" switch.
//
// IDEMPOTENT BY DESIGN: if the machine is already prepared (the race-safe
// CliGateReconnectConsole task exists) this is a no-op, so toggling desktop
// control off then on again NEVER re-prompts for admin — that is the whole
// "set up once, then open/close freely" contract. When NOT yet prepared:
//   - CliGate already elevated  -> run the prep in-process (silent, no UAC), or
//   - CliGate not elevated      -> raise a SINGLE Windows UAC consent so the
//                                  user authorizes it with one click (no script,
//                                  no command to paste).
// Returns quickly; callers confirm success by polling getStatus().prepared.
export async function prepare() {
  if (!isWindows()) {
    return { ok: false, supported: false, error: 'desktop machine preparation is Windows-only' };
  }
  const status = await getStatus();
  if (status.prepared) {
    return { ok: true, alreadyPrepared: true, prepared: true, status };
  }
  if (status.elevated) {
    const { code, tail } = await runScriptDirect(['-SkipAutoLogin']);
    const after = await getStatus();
    if (after.prepared) {
      return { ok: true, ranDirect: true, prepared: true, status: after };
    }
    return { ok: false, ranDirect: true, code, error: 'setup ran but the reconnect task was not created; see the tail', tail, status: after };
  }
  const launch = launchElevatedSetup(['-SkipAutoLogin']);
  if (!launch.launched) {
    return { ok: false, viaUac: true, declined: launch.declined === true, error: launch.error || 'could not launch the elevated one-time setup' };
  }
  return { ok: true, viaUac: true, pendingConsent: true };
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

// Remove ONLY the legacy auto-start tasks (CliGateDesktopAgent + CliGateServer)
// without touching the race-safe reconnect task, power/lock settings, or
// auto-login. This is the "Remove legacy auto-start tasks" repair action.
export async function removeLegacyTasks() {
  if (!isWindows()) {
    return { ok: false, supported: false, error: 'desktop machine preparation is Windows-only' };
  }
  const elevated = await isElevated();
  if (!elevated) {
    return {
      ok: false,
      needsAdmin: true,
      command: removeLegacyCommand(),
      error: 'CliGate is not running as administrator. Run the shown command once in an elevated PowerShell to remove the legacy auto-start tasks.'
    };
  }
  const { code, tail } = await runScriptDirect(['-RemoveLegacyTasks']);
  const status = await getStatus();
  if (!status.legacy?.present) {
    return { ok: true, ranDirect: true, code, status };
  }
  return { ok: false, ranDirect: true, code, error: 'removal ran but legacy tasks are still present; see the tail', tail, status };
}

export default {
  getStatus,
  enable,
  prepare,
  disable,
  removeLegacyTasks,
  isElevated,
  manualCommand,
  removeLegacyCommand,
  uninstallCommand
};
