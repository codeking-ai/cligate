<#
  setup-desktop-capture.ps1
  =========================================================================
  ONE-SHOT setup so screenshot + click work in ALL THREE scenarios on a
  headless / remote Windows mini-PC:
      (1) physical monitor   (2) HDMI dummy display   (3) Remote Desktop
  plus the hard case: screenshots keep working AFTER you disconnect RDP.

  The root requirement on Windows is simply: there must always be ONE
  logged-in, UNLOCKED, rendering desktop session, and the desktop agent must
  run inside it. This script makes that true automatically.

  Run ONCE in an *Administrator* PowerShell. The ONLY thing it asks for is the
  Windows password of the auto-login user (Windows needs a credential to log in
  unattended — no software can avoid that). Everything else is automatic.

  What it configures (all reversible with -Uninstall):
    1. Desktop agent auto-starts at logon, in the user's interactive session
       (CliGateDesktopAgent task).
    2. On RDP disconnect, the session is bounced back to the console so it stays
       active + unlocked (CliGateReconnectConsole task).
    3. The user auto-logs-in to the console session at boot (so the HDMI dummy /
       physical monitor always has a logged-in desktop, no human needed).
    4. Never lock / never sleep / no screensaver (keeps that desktop alive).
    5. (optional) CliGate server auto-starts at logon (CliGateServer task), so a
       reboot brings the whole stack back with nobody connected.

  Usage:
    powershell -ExecutionPolicy Bypass -File setup-desktop-capture.ps1
    powershell -ExecutionPolicy Bypass -File setup-desktop-capture.ps1 -SkipAutoLogin
    powershell -ExecutionPolicy Bypass -File setup-desktop-capture.ps1 -SkipCligateAutostart
    powershell -ExecutionPolicy Bypass -File setup-desktop-capture.ps1 -CligateRepo "D:\github\proxypool-hub"
    powershell -ExecutionPolicy Bypass -File setup-desktop-capture.ps1 -Uninstall
  =========================================================================
#>
param(
  [string]$TargetUser = $env:USERNAME,
  [int]$AgentPort = 8765,
  [string]$CligateRepo = '',
  [switch]$SkipAutoLogin,
  [switch]$SkipCligateAutostart,
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

# ---------------------------------------------------------------- UNINSTALL
if ($Uninstall) {
  Step "Removing agent + reconnect + server tasks"
  try { & (Join-Path $here 'install-elevated-task.ps1') -Uninstall } catch { Warn $_.Exception.Message }
  try { & (Join-Path $here 'install-reconnect-console-task.ps1') -Uninstall } catch { Warn $_.Exception.Message }
  & schtasks.exe /Delete /TN 'CliGateServer' /F 2>$null | Out-Null

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

# ---------------------------------------------------------------- 1. agent task
Step "1/5  Desktop agent auto-start (CliGateDesktopAgent)"
try {
  & (Join-Path $here 'install-elevated-task.ps1') -Port $AgentPort | Out-Null
  Ok "agent will auto-start at logon in the user's interactive session"
} catch {
  Warn "agent task install failed: $($_.Exception.Message)"
}

# ---------------------------------------------------------------- 2. reconnect task
Step "2/5  Auto-return-to-console on RDP disconnect (CliGateReconnectConsole)"
try {
  & (Join-Path $here 'install-reconnect-console-task.ps1') -TargetUser $TargetUser | Out-Null
  Ok "disconnecting RDP will bounce the session back to the console (stays unlocked)"
} catch {
  Warn "reconnect task install failed: $($_.Exception.Message)"
}

# ---------------------------------------------------------------- 3. keep desktop alive
Step "3/5  Keep the desktop alive (no screensaver / no sleep / no auto-lock)"
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

# ---------------------------------------------------------------- 4. auto-login
Step "4/5  Auto-login of '$TargetUser' to the console session"
if ($SkipAutoLogin) {
  Warn "skipped (-SkipAutoLogin). Headless/dummy capture needs this — set it via netplwiz or Sysinternals Autologon if you skip here."
} else {
  $sec = Read-Host "    Enter Windows password for '$TargetUser' (needed for unattended auto-login; press Enter to skip)" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  if ([string]::IsNullOrEmpty($plain)) {
    Warn "no password entered — auto-login NOT configured. (Headless capture will not work until you enable it.)"
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

# ---------------------------------------------------------------- 5. CliGate autostart
Step "5/5  CliGate server auto-start at logon (CliGateServer)"
if ($SkipCligateAutostart) {
  Warn "skipped (-SkipCligateAutostart). Remember: after a reboot CliGate must be running, or DingTalk has nothing to talk to."
} elseif (-not (Test-Path (Join-Path $CligateRepo 'package.json'))) {
  Warn "no package.json under '$CligateRepo' — skipping CliGate autostart. Re-run with -CligateRepo <path> to enable."
} else {
  $startCmd = Join-Path $CligateRepo 'start-cligate.cmd'
  @(
    '@echo off',
    'cd /d "' + $CligateRepo + '"',
    'npm start'
  ) | Set-Content -Path $startCmd -Encoding ASCII
  $tr = 'cmd.exe /c "' + $startCmd + '"'
  & schtasks.exe /Create /TN 'CliGateServer' /SC ONLOGON /RU $TargetUser /RL HIGHEST /TR $tr /F | Out-Null
  if ($LASTEXITCODE -eq 0) { Ok "CliGate will auto-start at logon ($startCmd)" } else { Warn "schtasks returned $LASTEXITCODE for CliGateServer" }
}

# ---------------------------------------------------------------- summary
Write-Host ""
Write-Host "Done. Summary:" -ForegroundColor Green
Write-Host "  - CliGateDesktopAgent    : agent auto-starts in the logged-in session"
Write-Host "  - CliGateReconnectConsole: RDP disconnect -> session returns to console"
Write-Host "  - CliGateServer          : CliGate auto-starts at logon (unless skipped)"
Write-Host "  - auto-login + no-lock   : the console always has a logged-in, unlocked desktop"
Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  1. Reboot the mini-PC (so auto-login lands '$TargetUser' on the console)."
Write-Host "  2. Do NOT connect via RDP. From DingTalk, ask the assistant to screenshot — it should work."
Write-Host "  3. To verify the session is on the console:  quser   (expect '$TargetUser' Active on 'console')."
Write-Host ""
Write-Host "Uninstall anytime:  powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Uninstall" -ForegroundColor DarkGray
