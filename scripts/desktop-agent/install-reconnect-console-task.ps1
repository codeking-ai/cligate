<#
  install-reconnect-console-task.ps1

  Registers a Scheduled Task that, whenever an RDP session is DISCONNECTED,
  reconnects it to the physical console (via reconnect-console.ps1) so the
  desktop stays active + unlocked for headless automation. The task runs as
  NT AUTHORITY\SYSTEM because `tscon ... /dest:console` requires it.

  Trigger: event log
    Microsoft-Windows-TerminalServices-LocalSessionManager/Operational
    Event ID 24 = "Session has been disconnected".
  (Reconnecting raises event 25, not 24, so there is no trigger loop.)

  Run ONCE in an *Administrator* PowerShell:
    powershell -ExecutionPolicy Bypass -File install-reconnect-console-task.ps1
    powershell -ExecutionPolicy Bypass -File install-reconnect-console-task.ps1 -TargetUser gdf_l
    powershell -ExecutionPolicy Bypass -File install-reconnect-console-task.ps1 -Uninstall
#>
param(
    [string]$TaskName   = 'CliGateReconnectConsole',
    [string]$TargetUser = $env:USERNAME,   # the auto-login user whose session should return to console
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Error "This script must be run from an elevated (Administrator) PowerShell. Right-click PowerShell -> Run as administrator."
        exit 1
    }
}

Assert-Admin

if ($Uninstall) {
    & schtasks.exe /Delete /TN $TaskName /F 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
    } else {
        Write-Host "Task '$TaskName' was not registered (nothing to remove)." -ForegroundColor Yellow
    }
    exit 0
}

# Copy the worker to a stable, SYSTEM-readable location so the task does not
# depend on the repo path (which may move or be on a per-user drive).
$srcWorker = Join-Path $PSScriptRoot 'reconnect-console.ps1'
if (-not (Test-Path $srcWorker)) {
    Write-Error "Cannot find reconnect-console.ps1 next to this installer at $srcWorker"
    exit 1
}
$destDir = Join-Path $env:ProgramData 'CliGate'
$null = New-Item -ItemType Directory -Force -Path $destDir
$destWorker = Join-Path $destDir 'reconnect-console.ps1'
Copy-Item -Path $srcWorker -Destination $destWorker -Force

# Windows PowerShell is always present; avoid a PS7 dependency for the task.
$psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $psExe)) { $psExe = 'powershell.exe' }

# Build the action command. The whole value is passed to schtasks /TR as one
# argument; inner double-quotes guard paths that may contain spaces.
$action = '"' + $psExe + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $destWorker + '" -TargetUser "' + $TargetUser + '"'

$channel = 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational'
$xpath   = "*[System[Provider[@Name='Microsoft-Windows-TerminalServices-LocalSessionManager'] and (EventID=24)]]"

$schtasksArgs = @(
    '/Create',
    '/TN', $TaskName,
    '/SC', 'ONEVENT',
    '/EC', $channel,
    '/MO', $xpath,
    '/RU', 'SYSTEM',
    '/RL', 'HIGHEST',
    '/TR', $action,
    '/F'
)

Write-Host "Registering scheduled task '$TaskName' (runs as SYSTEM on RDP disconnect)..." -ForegroundColor Cyan
& schtasks.exe @schtasksArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "schtasks failed with exit code $LASTEXITCODE."
    exit 1
}

Write-Host ""
Write-Host "Installed:" -ForegroundColor Green
Write-Host "  Task name  : $TaskName"
Write-Host "  Runs as    : NT AUTHORITY\SYSTEM (highest)"
Write-Host "  Trigger    : $channel  (EventID 24 = session disconnected)"
Write-Host "  Worker     : $destWorker"
Write-Host "  TargetUser : $TargetUser"
Write-Host "  Log        : $(Join-Path $destDir 'reconnect-console.log')"
Write-Host ""
Write-Host "Test it:" -ForegroundColor Cyan
Write-Host "  1) RDP into the machine, then just CLOSE the RDP window (do not log off)."
Write-Host "  2) Within a few seconds the session is bounced back to the console;"
Write-Host "     check $(Join-Path $destDir 'reconnect-console.log') and 'qwinsta'"
Write-Host "     (your user should show Active on 'console')."
Write-Host ""
Write-Host "Run worker manually (must be SYSTEM, e.g. via PsExec -s) to dry-run:" -ForegroundColor DarkGray
Write-Host "  psexec -s -i powershell -ExecutionPolicy Bypass -File `"$destWorker`" -TargetUser $TargetUser"
Write-Host ""
Write-Host "Uninstall:  powershell -ExecutionPolicy Bypass -File install-reconnect-console-task.ps1 -Uninstall" -ForegroundColor DarkGray
