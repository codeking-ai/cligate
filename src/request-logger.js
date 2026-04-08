/**
 * Request Logger
 * Asynchronously logs full request/response content for debugging and auditing.
 *
 * Design:
 *   - Zero latency impact: logging happens via setImmediate after response is sent
 *   - JSONL format: one JSON object per line, append-only (no need to parse whole file)
 *   - Daily rotation: ~/.cligate/request-logs/YYYY-MM-DD.jsonl
 *   - Auto-cleanup: deletes files older than configured retention days
 *   - Content truncation: request/response bodies capped at MAX_BODY_SIZE
 *   - Debounced flush: batches writes every 3 seconds to reduce I/O
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './account-manager.js';

const LOGS_DIR = join(CONFIG_DIR, 'request-logs');
const MAX_BODY_SIZE = 4096;       // Max chars per request/response body stored
const FLUSH_INTERVAL_MS = 3000;
const DEFAULT_RETENTION_DAYS = 7;
const MAX_QUERY_RESULTS = 100;

let buffer = [];
let flushTimer = null;
let enabled = true;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureLogsDir() {
    if (!existsSync(LOGS_DIR)) {
        mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
    }
}

function todayFile() {
    return join(LOGS_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
}

function truncate(value, maxLen = MAX_BODY_SIZE) {
    if (value === undefined || value === null) return null;
    let str = typeof value === 'string' ? value : JSON.stringify(value);
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + `...(truncated, total ${str.length} chars)`;
}

function generateId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `req_${ts}_${rand}`;
}

// ─── Flush to disk ───────────────────────────────────────────────────────────

function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
}

function flush() {
    flushTimer = null;
    if (buffer.length === 0) return;

    const entries = buffer;
    buffer = [];

    ensureLogsDir();
    // Group by date in case buffer spans midnight
    const byDate = {};
    for (const entry of entries) {
        const dateKey = entry.timestamp.slice(0, 10);
        if (!byDate[dateKey]) byDate[dateKey] = [];
        byDate[dateKey].push(entry);
    }

    for (const [dateKey, dateEntries] of Object.entries(byDate)) {
        const filePath = join(LOGS_DIR, `${dateKey}.jsonl`);
        const lines = dateEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
        try {
            appendFileSync(filePath, lines, { mode: 0o600 });
        } catch { /* ignore write errors */ }
    }
}

// Flush on process exit
process.on('exit', flush);
process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });

// ─── Auto-cleanup ────────────────────────────────────────────────────────────

export function cleanupOldLogs(retentionDays = DEFAULT_RETENTION_DAYS) {
    if (!existsSync(LOGS_DIR)) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffKey = cutoff.toISOString().slice(0, 10);

    try {
        for (const file of readdirSync(LOGS_DIR)) {
            if (!file.endsWith('.jsonl')) continue;
            const dateKey = file.replace('.jsonl', '');
            if (dateKey < cutoffKey) {
                unlinkSync(join(LOGS_DIR, file));
            }
        }
    } catch { /* ignore */ }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Enable or disable request logging at runtime.
 */
export function setRequestLoggingEnabled(value) {
    enabled = !!value;
}

export function isRequestLoggingEnabled() {
    return enabled;
}

/**
 * Log a request/response asynchronously.
 * Call this AFTER the response has been sent to the client.
 *
 * @param {object} opts
 * @param {string} opts.route       - e.g. '/v1/chat/completions'
 * @param {string} opts.method      - HTTP method
 * @param {string} opts.provider    - Provider type
 * @param {string} opts.keyId       - API key ID
 * @param {string} opts.model       - Requested model
 * @param {string} opts.mappedModel - Actual model sent to provider
 * @param {*}      opts.requestBody - Request body (will be truncated)
 * @param {*}      opts.responseBody - Response body (will be truncated)
 * @param {number} opts.inputTokens
 * @param {number} opts.outputTokens
 * @param {number} opts.cost
 * @param {number} opts.durationMs
 * @param {number} opts.status      - HTTP status code
 * @param {boolean} opts.success
 * @param {string} opts.error
 */
export function logRequest(opts) {
    if (!enabled) return;

    // Defer off the critical path
    setImmediate(() => {
        const entry = {
            id: generateId(),
            timestamp: new Date().toISOString(),
            route: opts.route || '',
            method: opts.method || 'POST',
            provider: opts.provider || '',
            keyId: opts.keyId || '',
            model: opts.model || '',
            mappedModel: opts.mappedModel || opts.model || '',
            requestBody: truncate(opts.requestBody),
            responseBody: truncate(opts.responseBody),
            inputTokens: opts.inputTokens || 0,
            outputTokens: opts.outputTokens || 0,
            cost: opts.cost || 0,
            durationMs: opts.durationMs || 0,
            status: opts.status || 0,
            success: opts.success !== false,
            error: opts.error || null,
        };

        buffer.push(entry);
        scheduleFlush();
    });
}

// ─── Query API (for Dashboard) ──────────────────────────────────────────────

/**
 * Query logged requests with optional filters.
 *
 * @param {object} opts
 * @param {string} opts.date      - Date to query (YYYY-MM-DD), defaults to today
 * @param {number} opts.limit     - Max results (default 50)
 * @param {number} opts.offset    - Skip entries (default 0)
 * @param {string} opts.provider  - Filter by provider
 * @param {string} opts.model     - Filter by model (substring match)
 * @param {boolean} opts.errorsOnly - Only show failed requests
 * @returns {object} { entries, total, date }
 */
export function queryLogs({ date, limit = 50, offset = 0, provider, model, errorsOnly } = {}) {
    // Flush buffer to disk before querying so results are up-to-date
    flush();

    const dateKey = date || new Date().toISOString().slice(0, 10);
    const filePath = join(LOGS_DIR, `${dateKey}.jsonl`);

    if (!existsSync(filePath)) {
        return { entries: [], total: 0, date: dateKey };
    }

    let lines;
    try {
        lines = readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    } catch {
        return { entries: [], total: 0, date: dateKey };
    }

    // Parse and filter
    let entries = [];
    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            if (provider && entry.provider !== provider) continue;
            if (model && !entry.model?.includes(model) && !entry.mappedModel?.includes(model)) continue;
            if (errorsOnly && entry.success) continue;
            entries.push(entry);
        } catch { /* skip malformed lines */ }
    }

    // Reverse chronological
    entries.reverse();
    const total = entries.length;

    // Paginate
    const clampedLimit = Math.min(limit, MAX_QUERY_RESULTS);
    entries = entries.slice(offset, offset + clampedLimit);

    return { entries, total, date: dateKey };
}

/**
 * Get available log dates.
 * @returns {string[]} Array of date strings, newest first
 */
export function getLogDates() {
    flush();
    if (!existsSync(LOGS_DIR)) return [];
    try {
        return readdirSync(LOGS_DIR)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => f.replace('.jsonl', ''))
            .sort()
            .reverse();
    } catch {
        return [];
    }
}

// Run cleanup on module load
cleanupOldLogs();
