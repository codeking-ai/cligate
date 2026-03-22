/**
 * Usage Tracker
 * Tracks per-request usage data for cost monitoring and analytics.
 *
 * Storage (all under ~/.proxypool-hub/):
 *   - usage-stats.json:   Aggregated stats (daily, monthly, allTime, byProvider, byModel)
 *   - usage-history.json: Recent request history (persisted, max 2000 entries)
 *
 * Writes are debounced (2s) to avoid high-frequency I/O under load.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './account-manager.js';

const STATS_FILE = join(CONFIG_DIR, 'usage-stats.json');
const HISTORY_FILE = join(CONFIG_DIR, 'usage-history.json');
const MAX_HISTORY = 2000;
const DEBOUNCE_MS = 2000;

let aggregatedStats = null;
let usageHistory = null;
let savePending = false;
let saveTimer = null;

// ─── Load / Save ──────────────────────────────────────────────────────────────

function createEmptyStats() {
    return { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, errors: 0 };
}

function loadStats() {
    if (aggregatedStats !== null) return aggregatedStats;

    if (!existsSync(STATS_FILE)) {
        aggregatedStats = {
            daily: {},
            monthly: {},
            allTime: createEmptyStats(),
            byProvider: {},
            byModel: {}
        };
        return aggregatedStats;
    }

    try {
        aggregatedStats = JSON.parse(readFileSync(STATS_FILE, 'utf8'));
        if (!aggregatedStats.daily) aggregatedStats.daily = {};
        if (!aggregatedStats.monthly) aggregatedStats.monthly = {};
        if (!aggregatedStats.allTime) aggregatedStats.allTime = createEmptyStats();
        if (!aggregatedStats.byProvider) aggregatedStats.byProvider = {};
        if (!aggregatedStats.byModel) aggregatedStats.byModel = {};
    } catch {
        aggregatedStats = {
            daily: {},
            monthly: {},
            allTime: createEmptyStats(),
            byProvider: {},
            byModel: {}
        };
    }
    return aggregatedStats;
}

function loadHistory() {
    if (usageHistory !== null) return usageHistory;

    if (!existsSync(HISTORY_FILE)) {
        usageHistory = [];
        return usageHistory;
    }

    try {
        const data = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
        usageHistory = Array.isArray(data) ? data : [];
    } catch {
        usageHistory = [];
    }
    return usageHistory;
}

function scheduleSave() {
    if (savePending) return;
    savePending = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushToDisk, DEBOUNCE_MS);
}

function flushToDisk() {
    savePending = false;
    saveTimer = null;
    try {
        if (aggregatedStats) {
            writeFileSync(STATS_FILE, JSON.stringify(aggregatedStats, null, 2), { mode: 0o600 });
        }
        if (usageHistory) {
            writeFileSync(HISTORY_FILE, JSON.stringify(usageHistory), { mode: 0o600 });
        }
    } catch { /* ignore write errors */ }
}

// Flush on process exit
process.on('exit', flushToDisk);
process.on('SIGINT', () => { flushToDisk(); process.exit(0); });
process.on('SIGTERM', () => { flushToDisk(); process.exit(0); });

function getDateKey() {
    return new Date().toISOString().slice(0, 10);
}

function getMonthKey() {
    return new Date().toISOString().slice(0, 7);
}

function addToTarget(target, entry) {
    target.requests++;
    target.inputTokens += entry.inputTokens;
    target.outputTokens += entry.outputTokens;
    target.cost += entry.cost;
    if (!entry.success) target.errors++;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function recordRequest({
    provider,
    keyId,
    model,
    inputTokens = 0,
    outputTokens = 0,
    cost = 0,
    durationMs = 0,
    success = true,
    error = null
}) {
    const entry = {
        timestamp: new Date().toISOString(),
        provider,
        keyId,
        model,
        inputTokens,
        outputTokens,
        cost,
        durationMs,
        success,
        error
    };

    // History (persisted)
    const history = loadHistory();
    history.unshift(entry);
    if (history.length > MAX_HISTORY) {
        usageHistory = history.slice(0, MAX_HISTORY);
    }

    // Aggregated stats
    const stats = loadStats();
    const dayKey = getDateKey();
    const monthKey = getMonthKey();
    const providerKey = provider || 'unknown';
    const modelKey = model || 'unknown';

    if (!stats.daily[dayKey]) stats.daily[dayKey] = createEmptyStats();
    if (!stats.monthly[monthKey]) stats.monthly[monthKey] = createEmptyStats();
    if (!stats.byProvider[providerKey]) stats.byProvider[providerKey] = createEmptyStats();
    if (!stats.byModel[modelKey]) stats.byModel[modelKey] = createEmptyStats();

    addToTarget(stats.daily[dayKey], entry);
    addToTarget(stats.monthly[monthKey], entry);
    addToTarget(stats.allTime, entry);
    addToTarget(stats.byProvider[providerKey], entry);
    addToTarget(stats.byModel[modelKey], entry);

    // Clean up old daily stats (keep 30 days)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    for (const key of Object.keys(stats.daily)) {
        if (key < cutoffKey) delete stats.daily[key];
    }

    // Clean up old monthly stats (keep 12 months)
    const monthCutoff = new Date();
    monthCutoff.setMonth(monthCutoff.getMonth() - 12);
    const monthCutoffKey = monthCutoff.toISOString().slice(0, 7);
    for (const key of Object.keys(stats.monthly)) {
        if (key < monthCutoffKey) delete stats.monthly[key];
    }

    scheduleSave();
    return entry;
}

export function getRecentHistory(limit = 50) {
    return loadHistory().slice(0, limit);
}

export function getDailyStats(days = 7) {
    const stats = loadStats();
    const result = [];
    const now = new Date();

    for (let i = 0; i < days; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        result.push({
            date: key,
            ...(stats.daily[key] || createEmptyStats())
        });
    }

    return result.reverse();
}

export function getMonthlyStats(months = 6) {
    const stats = loadStats();
    const result = [];
    const now = new Date();

    for (let i = 0; i < months; i++) {
        const d = new Date(now);
        d.setMonth(d.getMonth() - i);
        const key = d.toISOString().slice(0, 7);
        result.push({
            month: key,
            ...(stats.monthly[key] || createEmptyStats())
        });
    }

    return result.reverse();
}

export function getAllTimeStats() {
    return loadStats().allTime;
}

export function getTodayStats() {
    const stats = loadStats();
    return stats.daily[getDateKey()] || createEmptyStats();
}

export function getStatsByProvider() {
    return loadStats().byProvider;
}

export function getStatsByModel() {
    return loadStats().byModel;
}
