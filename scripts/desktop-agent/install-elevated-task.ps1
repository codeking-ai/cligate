# Registers a Scheduled Task that launches desktop-agent at user logon with
# HIGHEST privileges. This is the fix for "click reports success but the
# elevated installer window doesn't respond" — UIPI silently blocks input
# from medium-IL processes to high-IL windows. Running the agent under the
# task scheduler at HIGHEST integrity lets it drive installers, UAC-elevated
# apps, and the Windows Settings shell.
#
# Run this script ONCE in an *Administrator* PowerShell session. After that
# the task auto-starts at every logon, no UAC prompt.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-elevated-task.ps1
#   powershell -ExecutionPolicy Bypass -File install-elevated-task.ps1 -Port 8765
#   powershell -ExecutionPolicy Bypass -File install-elevated-task.ps1 -Uninstall

param(
    [string]$TaskName = 'CliGateDesktopAgent',
    [int]$Port = 8765,
    [string]$Python = '',
    [switch]$Uninstall,
    [switch]$StartNow
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Error "This script must be run from an elevated (Administrator) PowerShell. Right-click PowerShell -> Run as administrator."
        exit 1
    }
}

function Resolve-Python {
    if ($Python) { return $Python }
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $cmd = Get-Command py -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    Write-Error "Could not find python on PATH. Pass -Python C:\path\to\python.exe explicitly."
    exit 1
}

Assert-Admin

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
    } else {
        Write-Host "Task '$TaskName' was not registered." -ForegroundColor Yellow
    }
    exit 0
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$serverScript = Join-Path $repoRoot 'scripts\desktop-agent\desktop-agent-server.py'
if (-not (Test-Path $serverScript)) {
    Write-Error "Cannot find desktop-agent-server.py at $serverScript"
    exit 1
}

$pythonPath = Resolve-Python
$tokenFile = Join-Path $env:USERPROFILE '.cligate\desktop-agent.token'

$arguments = @(
    '"' + $serverScript + '"',
    '--port', $Port,
    '--token-file', '"' + $tokenFile + '"'
) -join ' '

# We want this to run as the *currently logged-in user* but with the user's
# highest available token (i.e. the elevated admin token if the account is
# in the Administrators group). This is the only Task Scheduler combination
# that:
#   - bypasses UAC consent prompts on every logon
#   - runs interactively (sees the desktop, captures pixels, sends input)
#   - reaches High-IL windows (so UIPI doesn't drop our clicks)
$action = New-ScheduledTaskAction -Execute $pythonPath -Argument $arguments -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Updating existing scheduled task '$TaskName'..." -ForegroundColor Cyan
    Set-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
} else {
    Write-Host "Registering scheduled task '$TaskName'..." -ForegroundColor Cyan
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
}

Write-Host ""
Write-Host "Installed:" -ForegroundColor Green
Write-Host "  Task name : $TaskName"
Write-Host "  Python    : $pythonPath"
Write-Host "  Script    : $serverScript"
Write-Host "  Port      : $Port"
Write-Host "  TokenFile : $tokenFile"
Write-Host ""

if (-not (Test-Path $tokenFile)) {
    Write-Host "NOTE: $tokenFile does not exist yet." -ForegroundColor Yellow
    Write-Host "      Start CliGate at least once so it generates the token, then sign out and"
    Write-Host "      back in (or run with -StartNow) to launch the elevated agent."
}

if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started '$TaskName'." -ForegroundColor Green
}

Write-Host ""
Write-Host "Verify with:  Get-ScheduledTask -TaskName $TaskName | Select TaskName,State"
Write-Host "Uninstall:    powershell -ExecutionPolicy Bypass -File install-elevated-task.ps1 -Uninstall"
