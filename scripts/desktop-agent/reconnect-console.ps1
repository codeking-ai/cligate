<#
  reconnect-console.ps1

  Reconnect a DISCONNECTED RDP user session back to the physical console, so the
  desktop stays ACTIVE + UNLOCKED for headless automation (screenshot/click) on
  a mini-PC with an HDMI dummy display.

  Why this is needed:
    When you RDP into the machine and then close the client WITHOUT logging off,
    your session goes to "Disconnected" state and the console shows the lock
    screen. A disconnected session's desktop is no longer the active input
    desktop, so synthetic clicks (SendInput) no longer land — automation breaks
    until the session is reactivated. `tscon <id> /dest:console` reattaches the
    session to the console (unlocked, active), which restores both screenshots
    and clicks.

  Intended to be launched by a Scheduled Task running as NT AUTHORITY\SYSTEM on
  the TerminalServices "session disconnected" event (LocalSessionManager id 24).
  `tscon ... /dest:console` requires SYSTEM (SeTcbPrivilege); it will fail with
  "Access is denied" if run as a normal user. Safe to run manually for testing.

  Params:
    -TargetUser : only reconnect a disconnected session for this user (e.g.
                  gdf_l). Empty = reconnect any disconnected interactive session.
    -Retries / -DelayMs : the session state can lag the disconnect event a beat,
                  so we re-check a few times before giving up.
#>
param(
    [string]$TargetUser = '',
    [int]$Retries = 6,
    [int]$DelayMs = 1000
)

$ErrorActionPreference = 'Stop'

$logDir = Join-Path $env:ProgramData 'CliGate'
try { $null = New-Item -ItemType Directory -Force -Path $logDir -ErrorAction Stop } catch {}
$logPath = Join-Path $logDir 'reconnect-console.log'

function Write-Log([string]$message) {
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    try { Add-Content -Path $logPath -Value "$ts  $message" -ErrorAction Stop } catch {}
}

# Parse qwinsta to find disconnected sessions. The STATE column values
# ('Active','Disc','Conn','Listen') are emitted in English regardless of the
# OS display language, so matching on 'Disc' is locale-safe. We pull the
# numeric session id that immediately precedes the 'Disc' keyword and skip
# session 0 (the non-interactive Services session, which is always 'Disc').
function Get-DisconnectedSessionIds([string]$user) {
    $ids = @()
    $lines = & qwinsta 2>$null
    foreach ($line in $lines) {
        if ($line -notmatch '\bDisc\b') { continue }
        if ($line -match '\s(\d+)\s+Disc\b') {
            $id = [int]$matches[1]
            if ($id -le 0) { continue }
            if ($user -and ($line -notmatch [regex]::Escape($user))) { continue }
            $ids += $id
        }
    }
    return $ids
}

Write-Log "reconnect-console invoked. TargetUser='$TargetUser'."

$reconnected = $false
for ($attempt = 1; $attempt -le $Retries -and -not $reconnected; $attempt++) {
    $ids = @(Get-DisconnectedSessionIds -user $TargetUser)
    if ($ids.Count -eq 0) {
        Write-Log "attempt $attempt/${Retries}: no matching disconnected session yet."
        Start-Sleep -Milliseconds $DelayMs
        continue
    }
    foreach ($id in $ids) {
        Write-Log "attempt $attempt/${Retries}: running 'tscon $id /dest:console'."
        try {
            $out = & tscon $id /dest:console 2>&1
            $code = $LASTEXITCODE
            foreach ($o in $out) { Write-Log "  tscon: $o" }
            Write-Log "  tscon exit code = $code"
            if ($code -eq 0) { $reconnected = $true }
        } catch {
            Write-Log "  tscon error: $($_.Exception.Message)"
        }
    }
    if (-not $reconnected) { Start-Sleep -Milliseconds $DelayMs }
}

if ($reconnected) {
    Write-Log "Console session reconnected — desktop should be active + unlocked again."
} else {
    Write-Log "No disconnected session was reconnected (TargetUser='$TargetUser'). If this keeps happening, run this script as SYSTEM (tscon /dest:console needs it) and confirm the session is in 'Disc' state via qwinsta."
}
