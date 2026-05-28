/**
 * Per-key throttle for high-frequency log calls.
 *
 * Some out-edges (Codex CLI plugin polling, DingTalk reconnect on a broken
 * socket, model-discovery against an unreachable Ollama) fire predictably
 * at sub-second cadence. Logging each call gives no extra signal but
 * crowds out everything else. `logEveryNSeconds(key, seconds, fn)` only
 * invokes `fn` if at least `seconds` have passed since the last call with
 * the same key — every suppressed call increments a counter, and the next
 * unsuppressed call gets the suppressed count handed to it so the log can
 * say "...×42 in 60s" instead of pretending the burst didn't happen.
 *
 * Process-local state, no cleanup needed — the Map is keyed by short
 * application-defined strings (e.g. `"codex-catchall:/backend-api/ps/..."`)
 * so cardinality stays bounded.
 */

const _windows = new Map();

/**
 * Throttled log gate. `fn` receives `{ suppressed }` — the number of calls
 * that were swallowed since the last emit. If `suppressed > 0` the caller
 * should fold that into the log message.
 *
 * Returns true if `fn` was called, false if the call was suppressed.
 */
export function logEveryNSeconds(key, seconds, fn) {
    if (!key || !(seconds > 0) || typeof fn !== 'function') return false;
    const now = Date.now();
    const entry = _windows.get(key) || { lastAt: 0, suppressed: 0 };
    if (now - entry.lastAt >= seconds * 1000) {
        const suppressed = entry.suppressed;
        _windows.set(key, { lastAt: now, suppressed: 0 });
        try {
            fn({ suppressed });
        } catch {
            // logging should never throw out to callers
        }
        return true;
    }
    entry.suppressed += 1;
    _windows.set(key, entry);
    return false;
}

/**
 * Forget a key's window — call this on a "things got better" event so the
 * next failure logs immediately rather than waiting for the throttle window.
 */
export function resetLogSamplerKey(key) {
    _windows.delete(key);
}

export default {
    logEveryNSeconds,
    resetLogSamplerKey
};
