/**
 * Usage & Stats Route
 * Endpoints for usage monitoring, cost tracking, and analytics.
 */

import {
    getRecentHistory,
    getDailyStats,
    getMonthlyStats,
    getAllTimeStats,
    getTodayStats,
    getStatsByProvider,
    getStatsByModel,
    getStatsByAccount
} from '../usage-tracker.js';
import { getStats as getKeyStats } from '../api-key-manager.js';

export function handleGetUsageOverview(req, res) {
    const today = getTodayStats();
    const allTime = getAllTimeStats();
    const keyStats = getKeyStats();

    res.json({
        today,
        allTime,
        keys: keyStats
    });
}

export function handleGetUsageHistory(req, res) {
    const limit = parseInt(req.query.limit) || 50;
    const history = getRecentHistory(Math.min(limit, 200));
    res.json({ history });
}

export function handleGetDailyStats(req, res) {
    const days = parseInt(req.query.days) || 7;
    const stats = getDailyStats(Math.min(days, 30));
    res.json({ stats });
}

export function handleGetMonthlyStats(req, res) {
    const months = parseInt(req.query.months) || 6;
    const stats = getMonthlyStats(Math.min(months, 12));
    res.json({ stats });
}

export function handleGetProviderStats(req, res) {
    const stats = getStatsByProvider();
    res.json({ stats });
}

export function handleGetModelStats(req, res) {
    const stats = getStatsByModel();
    res.json({ stats });
}

export function handleGetAccountStats(req, res) {
    const stats = getStatsByAccount();
    res.json({ stats });
}
