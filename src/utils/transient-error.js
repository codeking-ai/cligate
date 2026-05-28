/**
 * Shared classifier for "is this error worth retrying?" across the LLM-facing
 * out edges (Anthropic, ChatGPT responses, Azure OpenAI, supervisor tier
 * loop). Previously every provider grew its own subtly-different keyword
 * list; this module is the single source of truth so weak networks get the
 * same treatment everywhere.
 *
 * "Transient upstream" means the request did not reach a meaningful
 * application response — TCP reset, DNS hiccup, undici socket teardown,
 * dispatcher timeout. NOT included on purpose:
 *   - 4xx (caller's fault — INVALID_REQUEST, AUTH_EXPIRED, MODEL_QUOTA_EXHAUSTED)
 *   - 429 RATE_LIMITED (must wait for retry-after, not blind retry)
 *   - 5xx (handled separately if at all; many 5xx come back as a parsed
 *     Response so they don't reach this layer)
 */

const TRANSIENT_PATTERNS = [
    'other side closed',
    'socket hang up',
    'fetch failed',
    'econnreset',
    'econnrefused',
    'etimedout',
    'eai_again',
    'enotfound',
    'und_err_socket',
    'und_err_connect_timeout',
    'und_err_headers_timeout',
    'und_err_body_timeout',
    'und_err_req_content_length_mismatch',
    'connect timeout',
    'headers timeout',
    'body timeout',
    'network error'
];

export function collectErrorMessages(error) {
    const messages = [];
    const queue = [error];
    const seen = new Set();

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || seen.has(current)) continue;
        seen.add(current);

        if (typeof current.message === 'string' && current.message.length > 0) {
            messages.push(current.message);
        }
        if (typeof current.code === 'string' && current.code.length > 0) {
            messages.push(current.code);
        }
        if (current.cause && typeof current.cause === 'object') {
            queue.push(current.cause);
        }
    }

    return messages.map((msg) => msg.toLowerCase());
}

export function isTransientUpstreamError(error) {
    if (!error) return false;
    const haystack = collectErrorMessages(error).join(' | ');
    return TRANSIENT_PATTERNS.some((pattern) => haystack.includes(pattern));
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Backoff with full jitter: each attempt waits in
 *   [0, baseMs * 2^(attempt-1) + baseMs]
 * Capped at maxMs. Picking jitter over a fixed exponential avoids the
 * thundering-herd / synchronized-retry pattern where every concurrent
 * request hits the same upstream window again.
 */
export function backoffDelayMs(attempt, { baseMs = 250, maxMs = 4000 } = {}) {
    const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
    return Math.floor(Math.random() * (exp + baseMs));
}

/**
 * Standard "retry on transient fetch failure" wrapper used by the LLM
 * outbound layer. Callers provide a fetch-shaped thunk; the wrapper retries
 * up to `attempts` times if the thunk throws and the error matches the
 * transient classifier above. Any non-transient throw is rethrown
 * immediately so 4xx/INVALID_REQUEST stay sticky.
 *
 * NOTE: This is for the *connect/request* phase only. Do not wrap calls
 * that have already started streaming response bytes — replaying them is
 * not safe.
 */
export async function fetchWithTransientRetry(thunk, {
    attempts = 3,
    onRetry = null,
    baseMs = 250,
    maxMs = 4000
} = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await thunk(attempt);
        } catch (error) {
            lastError = error;
            const isLast = attempt >= attempts;
            if (isLast || !isTransientUpstreamError(error)) {
                throw error;
            }
            if (typeof onRetry === 'function') {
                try {
                    onRetry({ attempt, error });
                } catch {
                    // onRetry is only logging — never let it mask the real failure
                }
            }
            await sleep(backoffDelayMs(attempt, { baseMs, maxMs }));
        }
    }
    throw lastError;
}

export default {
    isTransientUpstreamError,
    collectErrorMessages,
    sleep,
    backoffDelayMs,
    fetchWithTransientRetry
};
