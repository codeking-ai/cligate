/**
 * OpenClaw Configuration Utility
 * Reads and writes ~/.openclaw/openclaw.json to configure OpenClaw
 * to use ProxyPool Hub as a custom model provider.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const OPENCLAW_CONFIG_FILE = join(OPENCLAW_DIR, 'openclaw.json');

const PROVIDER_ID = 'proxypool';

function ensureOpenClawDir() {
    if (!existsSync(OPENCLAW_DIR)) {
        mkdirSync(OPENCLAW_DIR, { recursive: true });
    }
}

export function readOpenClawConfig() {
    if (!existsSync(OPENCLAW_CONFIG_FILE)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(OPENCLAW_CONFIG_FILE, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Check current proxy status from the config.
 */
export function getProxyStatus() {
    const config = readOpenClawConfig();
    if (!config) {
        return { installed: false, configured: false };
    }

    const provider = config.models?.providers?.[PROVIDER_ID];
    const primaryModel = config.agents?.defaults?.model?.primary || '';
    const isUsingProxy = primaryModel.startsWith(`${PROVIDER_ID}/`);

    return {
        installed: true,
        configured: !!provider,
        active: isUsingProxy,
        baseUrl: provider?.baseUrl || null,
        apiType: provider?.api || null,
        primaryModel,
        models: provider?.models?.map(m => m.id) || [],
        configPath: OPENCLAW_CONFIG_FILE
    };
}

/**
 * Set proxy mode: add proxypool provider and set it as default model.
 */
export function setProxyMode(port, { apiType = 'anthropic-messages' } = {}) {
    ensureOpenClawDir();

    let config = readOpenClawConfig();
    if (!config) {
        config = {};
    }

    // Ensure nested structures exist
    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    if (!config.agents.defaults.model) config.agents.defaults.model = {};
    if (!config.agents.defaults.models) config.agents.defaults.models = {};

    const baseUrl = `http://localhost:${port}`;

    const models = apiType === 'anthropic-messages'
        ? [
            { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
            { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
            { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' }
        ]
        : [
            { id: 'gpt-5.2', name: 'GPT-5.2' },
            { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
            { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (via proxy)' }
        ];

    const defaultModel = apiType === 'anthropic-messages'
        ? 'claude-sonnet-4-6'
        : 'gpt-5.2';

    // Set the custom provider
    config.models.providers[PROVIDER_ID] = {
        baseUrl,
        apiKey: 'sk-ant-proxy',
        api: apiType,
        models
    };

    // Set default model to use our provider
    const previousModel = config.agents.defaults.model.primary;
    config.agents.defaults.model.primary = `${PROVIDER_ID}/${defaultModel}`;

    // Add model aliases for easy switching
    for (const m of models) {
        config.agents.defaults.models[`${PROVIDER_ID}/${m.id}`] = {
            alias: m.name
        };
    }

    writeFileSync(OPENCLAW_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');

    return {
        previousModel,
        baseUrl,
        apiType,
        defaultModel: `${PROVIDER_ID}/${defaultModel}`,
        models: models.map(m => `${PROVIDER_ID}/${m.id}`)
    };
}

/**
 * Remove proxy provider and restore previous model.
 */
export function setDirectMode() {
    const config = readOpenClawConfig();
    if (!config) {
        return { success: false, message: 'OpenClaw config not found' };
    }

    // Remove the provider
    if (config.models?.providers?.[PROVIDER_ID]) {
        delete config.models.providers[PROVIDER_ID];
    }

    // Remove model aliases
    if (config.agents?.defaults?.models) {
        for (const key of Object.keys(config.agents.defaults.models)) {
            if (key.startsWith(`${PROVIDER_ID}/`)) {
                delete config.agents.defaults.models[key];
            }
        }
    }

    // Reset default model if it's using our provider
    if (config.agents?.defaults?.model?.primary?.startsWith(`${PROVIDER_ID}/`)) {
        // Try to fall back to first available non-proxypool model
        const otherModels = Object.keys(config.agents?.defaults?.models || {})
            .filter(k => !k.startsWith(`${PROVIDER_ID}/`));
        config.agents.defaults.model.primary = otherModels[0] || '';
    }

    writeFileSync(OPENCLAW_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');

    return { success: true };
}

export default { readOpenClawConfig, getProxyStatus, setProxyMode, setDirectMode };
