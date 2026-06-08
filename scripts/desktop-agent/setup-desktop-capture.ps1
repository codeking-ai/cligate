<#
  setup-desktop-capture.ps1   (machine preparation — ADVANCED, opt-in)
  =========================================================================
  Prepares this Windows mini-PC so the assistant's screenshot + click keep
  working across all THREE display scenarios:
      (1) physical monitor   (2) HDMI dummy display   (3) Remote Desktop
  including the hard case: screenshots keep working AFTER you DISCONNECT RDP.

  IMPORTANT — what this is NOT (changed):
    This script NO LONGER installs any auto-start service. It does NOT make the
    desktop agent or CliGate start at Windows logon. Desktop control is a
    CliGate-OWNED runtime capability that you enable from inside CliGate; the
    agent lives and dies with CliGate. This script only does the *machine-level*
    preparation that Windows itself requires for headless/remote desktop use,
    and it actively REMOVES the old auto-start tasks if it finds them.

  What it configures (all reversible with -Uninstall):
    1. On RDP disconnect, the (now disconnected) session is bounced back to the
       console so the desktop stays active + unlocked — RACE-SAFE: it never
       fights an incoming or active RDP connection (CliGateReconnectConsole).
    2. Never lock / never sleep / no screensaver (keeps that desktop alive).
    3. (optional, -SkipAutoLogin to skip) auto-login the user to the console at
       boot, so a headless box has a live desktop with nobody connected.

  What it explicitly does NOT do anymore (removed — these caused the desktop
  agent / CliGate to come up BEFORE the user opened CliGate, and the agent task
  is also what made "RDP already connected / can't connect" worse):
    - install CliGateDesktopAgent  (agent auto-start at logon)   <-- REMOVED
    - install CliGateServer        (CliGate auto-start at logon)  <-- REMOVED
  If those legacy tasks exist, this script removes them (see -RemoveLegacyTasks).

  Run ONCE in an *Administrator* PowerShell.

  Usage:
    powershell -ExecutionPolicy Bypass -File setup-desktop-capture.ps1
    powershell -ExecutionPolicy Bypass -File setup-desktop-capture.ps1 -SkipAutoLogin
    powershell -ExecutionPolicy Bypass -File setup-desktop-capture.ps1 -RemoveLegacyTasks
    powershell -ExecutionPolicy Bypass -File setup-desktop-capture.ps1 -Uninstall
  =========================================================================
#>
param(
  [string]$TargetUser = $env:USERNAME,
  [int]$AgentPort = 8765,            # accepted for backward-compat; no agent task is installed anymore
  [string]$CligateRepo = '',         # accepted for backward-compat; no CliGate task is installed anymore
  [switch]$SkipAutoLogin,
  [switch]$SkipCligateAutostart,     # accepted for backward-compat; now a no-op (CliGate task removed)
  [switch]$RemoveLegacyTasks,        # remove ONLY the legacy auto-start tasks, then exit
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Run this from an elevated (Administrator) PowerShell. Right-click PowerShell -> Run as administrator."
    exit 1
  }
}
function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    [warn] $msg" -ForegroundColor Yellow }

# Remove the two legacy auto-start tasks. Safe to call when they don't exist.
function Remove-LegacyAutostartTasks {
  Step "Removing legacy auto-start tasks (CliGateDesktopAgent, CliGateServer)"
  try { & (Join-Path $here 'install-elevated-task.ps1') -Uninstall | Out-Null } catch { Warn "CliGateDesktopAgent: $($_.Exception.Message)" }
  & schtasks.exe /Delete /TN 'CliGateServer' /F 2>$null | Out-Null
  Ok "legacy auto-start tasks removed (if they were present)"
}

Assert-Admin

# Log everything to a file — this script runs in an elevated window that closes
# immediately, so without a transcript any sub-step failure is invisible. The
# dashboard / support can read this to see exactly what happened.
$logDir = Join-Path $env:ProgramData 'CliGate'
try { $null = New-Item -ItemType Directory -Force -Path $logDir -ErrorAction Stop } catch {}
$setupLog = Join-Path $logDir 'setup-desktop-capture.log'
try { Start-Transcript -Path $setupLog -Append -ErrorAction Stop | Out-Null } catch {}

if (-not $CligateRepo) {
  # default: repo root is two levels up from scripts/desktop-agent
  $CligateRepo = (Resolve-Path (Join-Path $here '..\..')).Path
}

# ----------------------------------------------------- REMOVE LEGACY (only)
if ($RemoveLegacyTasks) {
  Remove-LegacyAutostartTasks
  Write-Host ""
  Write-Host "Done. Legacy auto-start tasks removed. Desktop control is now CliGate-owned." -ForegroundColor Green
  exit 0
}

# ---------------------------------------------------------------- UNINSTALL
if ($Uninstall) {
  Step "Removing reconnect-console + legacy auto-start tasks"
  try { & (Join-Path $here 'install-reconnect-console-task.ps1') -Uninstall } catch { Warn $_.Exception.Message }
  Remove-LegacyAutostartTasks

  Step "Disabling auto-login"
  try {
    Set-ItemProperty $winlogon -Name AutoAdminLogon -Value '0'
    Remove-ItemProperty $winlogon -Name DefaultPassword -ErrorAction SilentlyContinue
    Ok "AutoAdminLogon = 0"
  } catch { Warn $_.Exception.Message }

  Step "Re-enabling lock-on-wake"
  try { & powercfg.exe -SETACVALUEINDEX SCHEME_CURRENT SUB_NONE CONSOLELOCK 1; & powercfg.exe -SETACTIVE SCHEME_CURRENT } catch {}
  Write-Host ""
  Write-Host "Reverted. (Screensaver/sleep timeouts were left as-is — set them back in Settings if you want.)" -ForegroundColor Green
  exit 0
}

# =========================================================================
# MAIN PATH: machine preparation (no auto-start services)
# =========================================================================

# ---------------------------------------------------------------- 0. clean legacy
# Preparing the new way must not leave the old auto-start tasks behind — they are
# exactly what brought the agent/CliGate up before the user opened CliGate.
Remove-LegacyAutostartTasks

# ---------------------------------------------------------------- 1. reconnect task
Step "1/3  Auto-return-to-console on RDP disconnect (CliGateReconnectConsole, race-safe)"
try {
  & (Join-Path $here 'install-reconnect-console-task.ps1') -TargetUser $TargetUser | Out-Null
  Ok "disconnecting RDP bounces the session back to the console; reconnecting RDP is never blocked"
} catch {
  Warn "reconnect task install failed: $($_.Exception.Message)"
}

# ---------------------------------------------------------------- 2. keep desktop alive
Step "2/3  Keep the desktop alive (no screensaver / no sleep / no auto-lock)"
try {
  Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaveActive  -Value '0'
  Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaverIsSecure -Value '0'
  Ok "screensaver off"
} catch { Warn "screensaver: $($_.Exception.Message)" }
try {
  & powercfg.exe -CHANGE standby-timeout-ac 0
  & powercfg.exe -CHANGE monitor-timeout-ac 0
  & powercfg.exe -CHANGE hibernate-timeout-ac 0
  Ok "AC sleep/monitor/hibernate timeouts = never"
} catch { Warn "powercfg timeouts: $($_.Exception.Message)" }
try {
  & powercfg.exe -SETACVALUEINDEX SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
  & powercfg.exe -SETACTIVE SCHEME_CURRENT
  Ok "require-password-on-wake = off"
} catch { Warn "consolelock: $($_.Exception.Message)" }
try {
  $polKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
  if (-not (Test-Path $polKey)) { New-Item -Path $polKey -Force | Out-Null }
  Set-ItemProperty $polKey -Name InactivityTimeoutSecs -Value 0 -Type DWord
  Ok "machine inactivity auto-lock = never"
} catch { Warn "inactivity policy: $($_.Exception.Message)" }

# ---------------------------------------------------------------- 3. auto-login (opt-in)
Step "3/3  Auto-login of '$TargetUser' to the console session (optional)"
if ($SkipAutoLogin) {
  Warn "skipped (-SkipAutoLogin). A headless box with no console login needs this for the HDMI dummy / physical monitor to have a live desktop — set it via netplwiz or Sysinternals Autologon if you skip here."
} else {
  $sec = Read-Host "    Enter Windows password for '$TargetUser' (needed for unattended auto-login; press Enter to skip)" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  if ([string]::IsNullOrEmpty($plain)) {
    Warn "no password entered — auto-login NOT configured."
  } else {
    Set-ItemProperty $winlogon -Name AutoAdminLogon  -Value '1'
    Set-ItemProperty $winlogon -Name DefaultUserName -Value $TargetUser
    Set-ItemProperty $winlogon -Name DefaultDomainName -Value $env:COMPUTERNAME
    Set-ItemProperty $winlogon -Name DefaultPassword -Value $plain
    $plain = $null
    Ok "auto-login enabled — on next boot '$TargetUser' logs into the console automatically"
    Warn "the password is stored in the registry (standard Windows AutoAdminLogon, readable by local admins). For LSA-encrypted storage instead, run Sysinternals Autologon.exe once and re-run this with -SkipAutoLogin."
  }
}

# ---------------------------------------------------------------- summary
Write-Host ""
Write-Host "Done. Summary:" -ForegroundColor Green
Write-Host "  - CliGateReconnectConsole: RDP disconnect -> session returns to console (race-safe)"
Write-Host "  - no-lock / no-sleep     : the console keeps a live, unlocked desktop"
Write-Host "  - auto-login             : $([bool](!$SkipAutoLogin)) (only if a password was entered)"
Write-Host "  - NO agent/CliGate auto-start tasks are installed (desktop control is CliGate-owned)"
Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  1. In CliGate, enable Desktop control (runtime). The agent starts with CliGate."
Write-Host "  2. You can RDP in/out freely — reconnecting is never blocked; when you disconnect,"
Write-Host "     the desktop falls back to the console for the HDMI dummy / physical monitor."
Write-Host "  3. Verify after a disconnect:  quser   (expect '$TargetUser' Active on 'console')."
Write-Host ""
Write-Host "Uninstall anytime:  powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Uninstall" -ForegroundColor DarkGray
