/**
 * Model Discovery Module
 *
 * Automatically discovers available models from all configured sources:
 *   - ChatGPT accounts (via model-api.js fetchModels)
 *   - API Key providers (via provider.listModels())
 *
 * Classifies each model by tier (flagship/standard/fast/reasoning) using
 * the existing recognizeTier() function from model-mapping.js.
 *
 * Picks the best (newest version) model per tier per provider and feeds
 * the results into model-mapping.js to keep tier mappings up-to-date.
 *
 * Cache TTL: 30 minutes. Auto-refreshes on startup.
 */

import { getActiveAccount, listAccounts } from './account-manager.js';
import { getCredentialsForAccount } from './middleware/credentials.js';
import { fetchModels } from './model-api.js';
import { getAllProviders } from './api-key-manager.js';
import { recognizeTier, refreshProviderModels, autoUpdateMappings } from './model-mapping.js';
import { logger } from './utils/logger.js';
import { getPrimaryLocalRuntime } from './local-runtime-manager.js';
import { listOllamaModels } from './runtimes/ollama.js';
import { logEveryNSeconds, resetLogSamplerKey } from './utils/log-sampler.js';

// Once a local runtime has failed N times in a row we stop fetching it
// entirely for the rest of the process — the URL clearly isn't listening
// and re-trying every 30 minutes just adds latency to discovery and a warn
// per attempt. The user's next deliberate action (changing the URL,
// enabling Ollama from the dashboard) will reset this in-memory state.
const LOCAL_RUNTIME_MAX_CONSECUTIVE_FAILURES = 3;
const _localRuntimeProbeState = { consecutiveFailures: 0, lastTriedAt: 0 };

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

let discoveryCache = {
    providers: {},   // { openai: { models: [...], tierMap: {...}, updatedAt } }
    lastRun: 0,
    running: false
};

let refreshTimer = null;

// ─── Filtering & version extraction ─────────────────────────────────────────

/**
 * Filter out experimental, internal, and non-production models.
 * These should not participate in tier auto-selection.
 */
const EXCLUDED_PATTERNS = [
    /[-_]oss[-_]|^gpt-oss/i, // open-source / experimental (gpt-oss-120b)
    /[-_]test[-_]|[-_]test$/i, // test models
    /[-_]internal/i,          // internal models
    /[-_]deprecated/i,        // deprecated models
];

function isProductionModel(modelId) {
    // Exclude models matching experimental patterns
    for (const pattern of EXCLUDED_PATTERNS) {
        if (pattern.test(modelId)) return false;
    }
    return true;
}

/**
 * Extract a comparable version number from a model ID.
 * Only matches version-like patterns (X.Y or brand-X-Y), NOT parameter counts.
 *
 * e.g. 'gpt-5.4' → 5.4, 'gpt-5.3-codex' → 5.3, 'claude-opus-4-6' → 4.6
 *      'gpt-oss-120b' → 0 (120b is a param count, not a version)
 * Returns 0 if no version is found.
 */
function extractVersion(modelId) {
    // Match X.Y version pattern (e.g. gpt-5.4, gemini-2.5)
    const dotMatch = modelId.match(/(?:^|[-_])(\d{1,2})\.(\d{1,2})(?:[-_.]|$)/);
    if (dotMatch) return parseFloat(`${dotMatch[1]}.${dotMatch[2]}`);

    // Match brand-X-Y pattern where X and Y are small numbers (e.g. claude-opus-4-6)
    // Excludes large numbers like 120b (parameter counts) and date stamps like 20250219
    const dashMatch = modelId.match(/(?:^|[a-z]-)(\d{1,2})-(\d{1,2})(?:[-_.]|$)/);
    if (dashMatch) return parseFloat(`${dashMatch[1]}.${dashMatch[2]}`);

    return 0;
}

/**
 * From a list of models in the same tier, pick the best one (highest version).
 * Only considers production models for auto-selection.
 */
function pickBest(models) {
    // Filter to production models first
    const production = models.filter(m => isProductionModel(m.id));
    const candidates = production.length > 0 ? production : models;

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    return candidates.sort((a, b) => extractVersion(b.id) - extractVersion(a.id))[0];
}

// ─── Discovery from ChatGPT accounts ────────────────────────────────────────

async function discoverFromChatGPTAccounts() {
    const { total, accounts } = listAccounts();
    if (total === 0) return [];

    // Try active account first, then any enabled account
    const active = getActiveAccount();
    const candidate = active || accounts.find(a => a.enabled !== false);
    if (!candidate) return [];

    try {
        const creds = await getCredentialsForAccount(candidate.email);
        if (!creds) return [];

        const models = await fetchModels(creds.accessToken, creds.accountId);
        logger.info(`[ModelDiscovery] ChatGPT account ${candidate.email}: found ${models.length} models`);
        return models.map(m => ({ id: m.id, name: m.name || m.id, source: 'chatgpt-account' }));
    } catch (err) {
        logger.warn(`[ModelDiscovery] ChatGPT account discovery failed: ${err.message}`);
        return [];
    }
}

// ─── Discovery from API Key providers ────────────────────────────────────────

async function discoverFromApiKeys() {
    const providers = getAllProviders();
    const results = {}; // { openai: [...], gemini: [...], ... }

    // Group providers by type and only try one per type
    const seen = new Set();
    for (const provider of providers) {
        if (seen.has(provider.type)) continue;
        if (!provider.isAvailable) continue;
        if (typeof provider.listModels !== 'function') continue;

        seen.add(provider.type);

        try {
            const models = await provider.listModels();
            if (Array.isArray(models) && models.length > 0) {
                results[provider.type] = models.map(m => ({
                    id: m.id || m,
                    name: m.name || m.id || m,
                    source: `apikey-${provider.type}`
                }));
                logger.info(`[ModelDiscovery] API key ${provider.type}: found ${results[provider.type].length} models`);
            }
        } catch (err) {
            logger.warn(`[ModelDiscovery] API key ${provider.type} discovery failed: ${err.message}`);
        }
    }

    return results;
}

async function discoverFromLocalRuntime() {
    const runtime = getPrimaryLocalRuntime();
    if (!runtime || runtime.enabled === false || runtime.type !== 'ollama' || !runtime.baseUrl) {
        return {};
    }

    // If we've already failed many times in a row, don't bother trying again
    // until something resets the state (config change, manual reset). The
    // dashboard's "test local runtime" action and successful discovery both
    // reset the counter via resetLocalRuntimeProbe() below.
    if (_localRuntimeProbeState.consecutiveFailures >= LOCAL_RUNTIME_MAX_CONSECUTIVE_FAILURES) {
        logEveryNSeconds('model-discovery:local-runtime:skipped', 6 * 3600, ({ suppressed }) => {
            const tail = suppressed > 0 ? ` (skipped ${suppressed} more probes since last log)` : '';
            logger.info(`[ModelDiscovery] Local runtime (${runtime.name}) marked unreachable after ${_localRuntimeProbeState.consecutiveFailures} consecutive failures — skipping until reset${tail}`);
        });
        return {};
    }

    _localRuntimeProbeState.lastTriedAt = Date.now();
    try {
        const models = await listOllamaModels(runtime.baseUrl);
        if (!Array.isArray(models) || models.length === 0) return {};
        _localRuntimeProbeState.consecutiveFailures = 0;
        resetLogSamplerKey('model-discovery:local-runtime:failed');
        resetLogSamplerKey('model-discovery:local-runtime:skipped');
        logger.info(`[ModelDiscovery] Local runtime ${runtime.name}: found ${models.length} models`);
        return {
            ollama: models.map(m => ({
                id: m.id || m,
                name: m.name || m.id || m,
                source: 'local-ollama'
            }))
        };
    } catch (err) {
        _localRuntimeProbeState.consecutiveFailures += 1;
        // First failure logs immediately, subsequent failures are throttled to
        // once every 6 hours so a persistently-broken local runtime doesn't
        // generate a warn every 30 minutes forever.
        logEveryNSeconds('model-discovery:local-runtime:failed', 6 * 3600, ({ suppressed }) => {
            const tail = suppressed > 0 ? ` (+${suppressed} suppressed since last log)` : '';
            logger.warn(`[ModelDiscovery] Local runtime discovery failed (${_localRuntimeProbeState.consecutiveFailures} consecutive): ${err.message}${tail}`);
        });
        return {};
    }
}

/**
 * Allow callers (e.g. "test connection" UI button, manual config change) to
 * forget the failure streak and try again on the next discovery cycle.
 */
export function resetLocalRuntimeProbe() {
    _localRuntimeProbeState.consecutiveFailures = 0;
    _localRuntimeProbeState.lastTriedAt = 0;
    resetLogSamplerKey('model-discovery:local-runtime:failed');
    resetLogSamplerKey('model-discovery:local-runtime:skipped');
}

// ─── Main discovery flow ─────────────────────────────────────────────────────

/**
 * Run full model discovery across all sources.
 * Classifies discovered models by tier and updates model-mapping.js.
 */
export async function discoverModels() {
    if (discoveryCache.running) {
        logger.info('[ModelDiscovery] Discovery already in progress, skipping');
        return discoveryCache;
    }

    discoveryCache.running = true;
    logger.info('[ModelDiscovery] Starting model discovery...');

    try {
        const providerResults = {};

        // 1. Discover from ChatGPT accounts → classify as 'openai' provider
        const chatgptModels = await discoverFromChatGPTAccounts();
        if (chatgptModels.length > 0) {
            providerResults.openai = classifyAndPick(chatgptModels);
        }

        // 2. Discover from API key providers
        const apiKeyModels = await discoverFromApiKeys();
        for (const [type, models] of Object.entries(apiKeyModels)) {
            // If we already got openai models from account, API key discovery supplements
            if (type === 'openai' && providerResults.openai) {
                // Merge: add any models from API key not already in account list
                const existingIds = new Set(providerResults.openai.models.map(m => m.id));
                const newModels = models.filter(m => !existingIds.has(m.id));
                if (newModels.length > 0) {
                    const merged = [...providerResults.openai.models, ...newModels];
                    providerResults.openai = classifyAndPick(merged);
                }
            } else {
                providerResults[type] = classifyAndPick(models);
            }
        }

        const localRuntimeModels = await discoverFromLocalRuntime();
        for (const [type, models] of Object.entries(localRuntimeModels)) {
            providerResults[type] = classifyAndPick(models);
        }

        // 3. Update caches
        discoveryCache.providers = providerResults;
        discoveryCache.lastRun = Date.now();

        // 4. Feed results into model-mapping.js
        for (const [providerType, data] of Object.entries(providerResults)) {
            refreshProviderModels(providerType, data.models);
            autoUpdateMappings(providerType, data.tierMap);
        }

        const summary = Object.entries(providerResults)
            .map(([type, data]) => `${type}:${data.models.length}`)
            .join(', ');
        logger.info(`[ModelDiscovery] Discovery complete: ${summary}`);

    } catch (err) {
        logger.error(`[ModelDiscovery] Discovery failed: ${err.message}`);
    } finally {
        discoveryCache.running = false;
    }

    return discoveryCache;
}

/**
 * Classify a list of models by tier and pick the best per tier.
 * @param {Array} models - [{id, name, source}]
 * @returns {{ models: Array, tierMap: { flagship: string, standard: string, fast: string, reasoning: string } }}
 */
function classifyAndPick(models) {
    const byTier = { flagship: [], standard: [], fast: [], reasoning: [] };

    for (const model of models) {
        const tier = recognizeTier(model.id);
        if (byTier[tier]) {
            byTier[tier].push(model);
        }
    }

    const tierMap = {};
    for (const [tier, tierModels] of Object.entries(byTier)) {
        const best = pickBest(tierModels);
        if (best) tierMap[tier] = best.id;
    }

    return { models, tierMap };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the cached discovery results.
 */
export function getDiscoveredModels() {
    return {
        providers: discoveryCache.providers,
        lastRun: discoveryCache.lastRun,
        cacheAge: discoveryCache.lastRun ? Date.now() - discoveryCache.lastRun : null,
        stale: discoveryCache.lastRun ? (Date.now() - discoveryCache.lastRun) > CACHE_TTL_MS : true
    };
}

/**
 * Get discovered models for a specific provider.
 * Returns the model ID list, or empty array if not discovered.
 */
export function getDiscoveredProviderModels(providerType) {
    const data = discoveryCache.providers[providerType];
    return data ? data.models.map(m => m.id) : [];
}

/**
 * Get the best model per tier for a specific provider from discovery.
 * Returns null if no discovery data exists for this provider.
 */
export function getDiscoveredTierMap(providerType) {
    const data = discoveryCache.providers[providerType];
    return data ? data.tierMap : null;
}

/**
 * Start periodic model discovery.
 * Runs immediately on first call, then every REFRESH_INTERVAL_MS.
 */
export function startModelDiscovery() {
    // Run first discovery after a short delay to let accounts/keys load
    setTimeout(() => {
        discoverModels().catch(err => {
            logger.error(`[ModelDiscovery] Initial discovery error: ${err.message}`);
        });
    }, 5000);

    // Periodic refresh
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
        discoverModels().catch(err => {
            logger.error(`[ModelDiscovery] Periodic discovery error: ${err.message}`);
        });
    }, REFRESH_INTERVAL_MS);
}

export function stopModelDiscovery() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}

export default {
    discoverModels,
    getDiscoveredModels,
    getDiscoveredProviderModels,
    getDiscoveredTierMap,
    startModelDiscovery,
    stopModelDiscovery,
    resetLocalRuntimeProbe
};
