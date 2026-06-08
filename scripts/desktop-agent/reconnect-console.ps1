<#
  reconnect-console.ps1  (race-safe)

  Reconnect a DISCONNECTED RDP user session back to the physical console, so the
  desktop stays ACTIVE + UNLOCKED for headless automation (screenshot/click) on
  a mini-PC with an HDMI dummy display or a physical monitor.

  Why this is needed:
    When you RDP into the machine and then close the client WITHOUT logging off,
    your session goes to "Disconnected" state and the console shows the lock
    screen. A disconnected session's desktop is no longer the active input
    desktop, so synthetic clicks (SendInput) no longer land — automation breaks
    until the session is reactivated. `tscon <id> /dest:console` reattaches the
    session to the console (unlocked, active), which restores both screenshots
    and clicks.

  -------------------------------------------------------------------------
  THE BUG THIS REWRITE FIXES (RDP "already connected / cannot connect"):
    The previous version fired on EVERY "session disconnected" event and, for
    ~6 seconds, aggressively forced the session to the console (6 retries, 1s
    apart). But CONNECTING via RDP also momentarily disconnects the session
    from the console (it has to be moved onto rdp-tcp), which fires the very
    same disconnect event. The old worker then yanked the session back to the
    console mid-handshake, killing the incoming RDP connection. Every retry lost
    the same race, so the user saw repeated "a remote desktop connection already
    exists / cannot connect" and the console got stuck in the 'Conn' state.

  THE FIX — only act when the machine is genuinely "disconnected and idle":
    1. DEBOUNCE: wait -StableSeconds after the disconnect event so a real
       reconnect handshake has time to complete before we look.
    2. GUARD: re-read the live session table and bounce to console ONLY if
         - the target user has a session in 'Disc' (something to reconnect), AND
         - the target user has NO 'Active' session anywhere (not already live), AND
         - NO rdp-tcp transport is busy (Active/Conn/Connecting/Shadow) — i.e.
           nobody is connected or connecting right now.
       If a connection is in progress or already active, we ABORT and do
       nothing, so we never fight an incoming or live RDP session.
    3. No aggressive retry loop — a single guarded action, re-verified once
       immediately before the move.
  -------------------------------------------------------------------------

  Intended to be launched by a Scheduled Task running as NT AUTHORITY\SYSTEM on
  the TerminalServices "session disconnected" event (LocalSessionManager id 24).
  `tscon ... /dest:console` requires SYSTEM (SeTcbPrivilege); it will fail with
  "Access is denied" if run as a normal user. Safe to run manually for testing.

  Params:
    -TargetUser    : only reconnect a disconnected session for this user (e.g.
                     gdf_l). Empty = match any disconnected interactive session.
    -StableSeconds : debounce window after the disconnect event before we look,
                     so an in-progress RDP reconnect can finish first (default 6).
    -DryRun        : evaluate + log the decision but DO NOT run tscon. Use this
                     to safely confirm the guard behaves before trusting it.
#>
param(
    [string]$TargetUser = '',
    [int]$StableSeconds = 6,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$logDir = Join-Path $env:ProgramData 'CliGate'
try { $null = New-Item -ItemType Directory -Force -Path $logDir -ErrorAction Stop } catch {}
$logPath = Join-Path $logDir 'reconnect-console.log'

function Write-Log([string]$message) {
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    try { Add-Content -Path $logPath -Value "$ts  $message" -ErrorAction Stop } catch {}
}

# Parse qwinsta into structured rows. The STATE column values ('Active','Conn',
# 'Disc','Listen', etc.) are emitted in English regardless of OS display
# language, so this is locale-safe. We tokenize each line and locate the integer
# session id immediately preceding the STATE keyword; the first token is the
# session name (a leading '>' marks the current session and is stripped); any
# token between the name and the id is the user name (may be absent).
function Get-Sessions {
    $rows = @()
    $lines = & qwinsta 2>$null
    foreach ($line in $lines) {
        $raw = ($line -replace '^>', ' ').TrimEnd()
        if ([string]::IsNullOrWhiteSpace($raw)) { continue }
        $tokens = ($raw -split '\s+') | Where-Object { $_ -ne '' }
        if ($tokens.Count -lt 3) { continue }
        # Find the STATE token (first recognized session-state keyword).
        $stateIdx = -1
        for ($i = 1; $i -lt $tokens.Count; $i++) {
            if ($tokens[$i] -match '^(Active|Conn|Connected|ConnectQuery|Shadow|Listen|Disc|Down|Init|Idle)$') {
                $stateIdx = $i
                break
            }
        }
        if ($stateIdx -lt 1) { continue }
        # The id is the integer token immediately before STATE.
        $idTok = $tokens[$stateIdx - 1]
        if ($idTok -notmatch '^\d+$') { continue }
        $name = $tokens[0]
        $user = ''
        if (($stateIdx - 1) -gt 1) {
            $user = ($tokens[1..($stateIdx - 2)] -join ' ')
        }
        $rows += [pscustomobject]@{
            SessionName = $name
            UserName    = $user
            Id          = [int]$idTok
            State       = $tokens[$stateIdx]
        }
    }
    return $rows
}

# Decide whether bouncing the target user's disconnected session to the console
# is SAFE right now. Returns a hashtable: @{ Act=$bool; DiscId=<int>; Reason=<str> }.
# This is the whole anti-race brain — pure function of the session table so it is
# easy to reason about and (with -DryRun) easy to verify on a live machine.
function Get-ReconnectDecision($sessions, [string]$user) {
    # An rdp-tcp transport in any non-idle state means a client is connected or
    # is in the middle of connecting — never touch the session in that window.
    $rdpBusy = @($sessions | Where-Object {
        $_.SessionName -match '^rdp-tcp' -and $_.State -notmatch '^(Disc|Listen|Down)$'
    })
    if ($rdpBusy.Count -gt 0) {
        $d = ($rdpBusy | ForEach-Object { "$($_.SessionName)/$($_.State)" }) -join ', '
        return @{ Act = $false; DiscId = 0; Reason = "an RDP connection is active or in progress ($d) — leaving it alone" }
    }

    $userRows = if ($user) {
        @($sessions | Where-Object { $_.UserName -and ($_.UserName -ieq $user) })
    } else {
        @($sessions | Where-Object { $_.Id -gt 0 -and $_.UserName })
    }

    $active = @($userRows | Where-Object { $_.State -match '^Active$' })
    if ($active.Count -gt 0) {
        return @{ Act = $false; DiscId = 0; Reason = "target session is already Active (id $($active[0].Id)) — nothing to do" }
    }

    $disc = @($userRows | Where-Object { $_.State -match '^Disc$' -and $_.Id -gt 0 } | Sort-Object Id)
    if ($disc.Count -eq 0) {
        return @{ Act = $false; DiscId = 0; Reason = "no disconnected session for '$user' — nothing to do" }
    }

    return @{ Act = $true; DiscId = $disc[0].Id; Reason = "session $($disc[0].Id) is Disc and no RDP client is connected/connecting" }
}

Write-Log "reconnect-console invoked. TargetUser='$TargetUser' StableSeconds=$StableSeconds DryRun=$($DryRun.IsPresent)."

# 1) DEBOUNCE — let an in-progress reconnect finish before we evaluate.
if ($StableSeconds -gt 0) { Start-Sleep -Seconds $StableSeconds }

# 2) GUARD — evaluate the live session table.
$sessions = Get-Sessions
$decision = Get-ReconnectDecision -sessions $sessions -user $TargetUser

if (-not $decision.Act) {
    Write-Log "skip: $($decision.Reason)."
    return
}

# 3) RE-VERIFY immediately before acting — closes the tiny window between the
#    evaluation above and the tscon call (a client may have just started
#    connecting). Cheap insurance against the exact race the old version lost.
$recheck = Get-ReconnectDecision -sessions (Get-Sessions) -user $TargetUser
if (-not $recheck.Act -or $recheck.DiscId -ne $decision.DiscId) {
    Write-Log "skip on re-verify: $($recheck.Reason)."
    return
}

if ($DryRun) {
    Write-Log "[dry-run] WOULD run 'tscon $($decision.DiscId) /dest:console' ($($decision.Reason))."
    return
}

Write-Log "running 'tscon $($decision.DiscId) /dest:console' ($($decision.Reason))."
try {
    $out = & tscon $decision.DiscId /dest:console 2>&1
    $code = $LASTEXITCODE
    foreach ($o in $out) { Write-Log "  tscon: $o" }
    Write-Log "  tscon exit code = $code"
    if ($code -eq 0) {
        Write-Log "Console session reconnected — desktop should be active + unlocked again."
    } else {
        Write-Log "tscon returned $code — see output above. (Must run as SYSTEM; SeTcbPrivilege required.)"
    }
} catch {
    Write-Log "  tscon error: $($_.Exception.Message)"
}
