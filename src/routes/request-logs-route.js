/**
 * Request Logs Route
 * Provides API for querying request/response logs from the dashboard.
 *
 * GET /api/request-logs          — Query logs with optional filters
 * GET /api/request-logs/dates    — List available log dates
 * GET /api/request-logs/settings — Get logging settings
 * PUT /api/request-logs/settings — Update logging settings
 */

import { queryLogs, getLogDates, setRequestLoggingEnabled, isRequestLoggingEnabled, cleanupOldLogs } from '../request-logger.js';
import { getServerSettings, setServerSettings } from '../server-settings.js';

/**
 * GET /api/request-logs
 * Query params: date, limit, offset, provider, model, errorsOnly
 */
export function handleGetRequestLogs(req, res) {
    res.set('Cache-Control', 'no-store');
    const { date, limit, offset, provider, model, errorsOnly } = req.query;
    const result = queryLogs({
        date,
        limit: limit ? parseInt(limit, 10) : 50,
        offset: offset ? parseInt(offset, 10) : 0,
        provider,
        model,
        errorsOnly: errorsOnly === 'true',
    });
    res.json(result);
}

/**
 * GET /api/request-logs/dates
 * Returns available log dates.
 */
export function handleGetLogDates(req, res) {
    res.set('Cache-Control', 'no-store');
    res.json({ dates: getLogDates() });
}

/**
 * GET /api/request-logs/settings
 */
export function handleGetLogSettings(req, res) {
    res.set('Cache-Control', 'no-store');
    const settings = getServerSettings();
    res.json({
        enabled: settings.enableRequestLogging !== false,
        retentionDays: settings.requestLogRetentionDays || 7,
    });
}

/**
 * PUT /api/request-logs/settings
 */
export function handleUpdateLogSettings(req, res) {
    const { enabled, retentionDays } = req.body;
    const patch = {};

    if (enabled !== undefined) {
        patch.enableRequestLogging = !!enabled;
        setRequestLoggingEnabled(!!enabled);
    }
    if (retentionDays !== undefined) {
        patch.requestLogRetentionDays = Math.max(1, Math.min(30, parseInt(retentionDays, 10) || 7));
    }

    const updated = setServerSettings(patch);

    if (patch.requestLogRetentionDays) {
        cleanupOldLogs(patch.requestLogRetentionDays);
    }

    res.json({
        enabled: updated.enableRequestLogging !== false,
        retentionDays: updated.requestLogRetentionDays || 7,
    });
}

export default { handleGetRequestLogs, handleGetLogDates, handleGetLogSettings, handleUpdateLogSettings };
