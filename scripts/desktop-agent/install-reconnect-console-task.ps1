<#
  install-reconnect-console-task.ps1

  Registers a Scheduled Task that, whenever an RDP session is DISCONNECTED,
  reconnects it to the physical console (via reconnect-console.ps1) so the
  desktop stays active + unlocked for headless automation. The task runs as
  NT AUTHORITY\SYSTEM because `tscon ... /dest:console` requires it.

  Trigger: event log
    Microsoft-Windows-TerminalServices-LocalSessionManager/Operational
    Event ID 24 = "Session has been disconnected".
  The worker is race-safe: it debounces, then only bounces to the console when
  the machine is genuinely disconnected-and-idle (no rdp-tcp client connected or
  connecting). Combined with -MultipleInstances IgnoreNew, a burst of disconnect
  events (e.g. during an RDP reconnect handshake) cannot start a fight or a loop.

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

# Register the EVENT-triggered task with PowerShell-native Register-ScheduledTask
# instead of schtasks.exe. schtasks /SC ONEVENT mangled the event XPath on the
# command line, and schtasks /Create /XML silently returned exit 0 WITHOUT
# creating the task — both failure modes were invisible. Register-ScheduledTask
# builds the event trigger from a CIM object (XPath is a plain property, no
# quoting) and THROWS a real, logged error if registration fails.
Write-Host "Registering scheduled task '$TaskName' (runs as SYSTEM on RDP disconnect)..." -ForegroundColor Cyan

$argLine = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $destWorker + '" -TargetUser "' + $TargetUser + '"'
$action = New-ScheduledTaskAction -Execute $psExe -Argument $argLine

# EventID 24 (session disconnected) on the LocalSessionManager/Operational log.
$subscription = '<QueryList><Query Id="0" Path="Microsoft-Windows-TerminalServices-LocalSessionManager/Operational"><Select Path="Microsoft-Windows-TerminalServices-LocalSessionManager/Operational">*[System[(EventID=24)]]</Select></Query></QueryList>'
$trigClass = Get-CimClass -Namespace 'Root/Microsoft/Windows/TaskScheduler' -ClassName 'MSFT_TaskEventTrigger'
$trigger = New-CimInstance -CimClass $trigClass -ClientOnly
$trigger.Enabled = $true
$trigger.Subscription = $subscription

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null

# Verify it actually exists (defensive — never claim success blindly again).
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Error "Register-ScheduledTask reported success but '$TaskName' is not present."
    exit 1
}

Write-Host ""
Write-Host "Installed:" -ForegroundColor Green
Write-Host "  Task name  : $TaskName"
Write-Host "  Runs as    : NT AUTHORITY\SYSTEM (highest)"
Write-Host "  Trigger    : TerminalServices-LocalSessionManager/Operational EventID 24 (session disconnected)"
Write-Host "  Worker     : $destWorker"
Write-Host "  TargetUser : $TargetUser"
Write-Host "  Log        : $(Join-Path $destDir 'reconnect-console.log')"
Write-Host ""
Write-Host "Test it:" -ForegroundColor Cyan
Write-Host "  1) RDP into the machine, then just CLOSE the RDP window (do not log off)."
Write-Host "  2) After the debounce window the session is bounced back to the console;"
Write-Host "     check $(Join-Path $destDir 'reconnect-console.log') and 'qwinsta'"
Write-Host "     (your user should show Active on 'console')."
Write-Host "  3) Reconnecting via RDP must NOT be blocked — the worker detects the"
Write-Host "     in-progress connection and skips (look for 'skip:' lines in the log)."
Write-Host ""
Write-Host "Dry-run the decision safely (logs what it WOULD do, runs no tscon):" -ForegroundColor DarkGray
Write-Host "  psexec -s -i powershell -ExecutionPolicy Bypass -File `"$destWorker`" -TargetUser $TargetUser -DryRun"
Write-Host ""
Write-Host "Uninstall:  powershell -ExecutionPolicy Bypass -File install-reconnect-console-task.ps1 -Uninstall" -ForegroundColor DarkGray
