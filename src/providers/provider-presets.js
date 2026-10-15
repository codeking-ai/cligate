/**
 * Provider Presets — single declarative source of truth for additively-onboarded
 * API-key providers.
 *
 * Borrowed (not copied) from cc-switch: a provider is a data entry keyed by
 * `apiFormat`, not a bespoke class. Adding an OpenAI-compatible vendor is a
 * single object here — no new class, no scattered edits.
 *
 * User-defined presets: entries in `~/.cligate/provider-presets.json` are
 * merged after the built-ins at module load, so adding a vendor at runtime is
 * a JSON file — no code changes, no restart beyond server reload. Built-in ids
 * are protected: a user preset that collides with one is skipped with a warning.
 *
 * SCOPE (this batch): Qwen (DashScope compatible-mode) and OpenRouter, both
 * `openai_chat`. They are intentionally exposed ONLY on the OpenAI chat path
 * (`/v1/chat/completions` + gateway). The generic provider class disables the
 * Responses and Anthropic bridges, so these vendors stay structurally invisible
 * to Codex (`/responses`), Claude Code (`/v1/messages`), and the assistant
 * (which only binds providers implementing `sendAnthropicRequest`).
 *
 * Preset fields:
 *   id                    string  provider type key — globally unique
 *   label                 string  human display name (neutral/English default)
 *   labelKey              string? dashboard i18n key for the display name (falls back to label)
 *   badge                 string  short UI tag
 *   apiFormat             string  'openai_chat' | 'openai_responses' | 'anthropic' | 'gemini_native'
 *   baseUrl               string  default upstream base URL
 *   website               string? provider console URL (UI link)
 *   keyHint               string? placeholder shown in the add-key form
 *   providerClass         string? custom class id (omit → generic OpenAICompatibleProvider)
 *   models                array?  known model ids (UI dropdown + tier auto-fill)
 *   tiers                 object? { flagship, standard, fast, reasoning } model mapping
 *   pricing               object? { <model>: { input, output, cacheRead?, cacheWrite? } } USD / 1M tokens
 *   nativeModelPrefixes   array?  model ids starting with any prefix are passed through (no tier remap)
 *   passthroughModelMatch string? if a model id includes this substring, pass it through (e.g. '/')
 *   validateModel         string? vendors without GET /models: validateKey sends a 1-token
 *                                 chat request with this model instead (e.g. Zhipu)
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from '../account-manager.js';

export const PROVIDER_PRESETS = [
  {
    id: 'qwen',
    label: 'Qwen',
    labelKey: 'providerQwen',
    badge: 'QWEN',
    apiFormat: 'openai_chat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    website: 'https://dashscope.console.aliyun.com',
    keyHint: 'sk-...',
    nativeModelPrefixes: ['qwen', 'qwq'],
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwq-32b'],
    tiers: {
      flagship: 'qwen-max',
      standard: 'qwen-plus',
      fast: 'qwen-turbo',
      reasoning: 'qwq-32b',
    },
    pricing: {
      'qwen-max': { input: 1.6, output: 6.4, cacheRead: 0, cacheWrite: 0 },
      'qwen-plus': { input: 0.4, output: 1.2, cacheRead: 0, cacheWrite: 0 },
      'qwen-turbo': { input: 0.05, output: 0.2, cacheRead: 0, cacheWrite: 0 },
      'qwq-32b': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    labelKey: 'providerOpenrouter',
    badge: 'OR',
    apiFormat: 'openai_chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    website: 'https://openrouter.ai',
    keyHint: 'sk-or-v1-...',
    // OpenRouter model ids are `vendor/model` slugs — pass them through verbatim
    // instead of tier-remapping a model the caller explicitly chose.
    passthroughModelMatch: '/',
    models: [
      'openai/gpt-4o-mini',
      'anthropic/claude-3.7-sonnet',
      'qwen/qwen-2.5-72b-instruct',
      'deepseek/deepseek-chat',
    ],
    // No built-in pricing: OpenRouter exposes hundreds of models with floating
    // prices. Cost estimates default to 0; users may add overrides in the
    // pricing page if desired.
    tiers: {
      flagship: 'anthropic/claude-3.7-sonnet',
      standard: 'openai/gpt-4o-mini',
      fast: 'openai/gpt-4o-mini',
      reasoning: 'deepseek/deepseek-r1',
    },
  },
  {
    // Migrated from the bespoke ZhipuProvider class. ZhipuAI serves no GET
    // /models, so validation probes a 1-token chat request and discovery
    // relies on the static model list below. Model ids verified against the
    // OpenRouter z-ai listing (2026-10).
    id: 'zhipu',
    label: 'Zhipu (GLM)',
    labelKey: 'providerZhipu',
    badge: 'GLM',
    apiFormat: 'openai_chat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    website: 'https://open.bigmodel.cn',
    keyHint: '...',
    nativeModelPrefixes: ['glm'],
    validateModel: 'glm-4-flash',
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5', 'glm-4.7', 'glm-4.7-flash', 'glm-4-flash'],
    tiers: {
      flagship: 'glm-5.3',
      standard: 'glm-5.2',
      fast: 'glm-5.3-flash',
      reasoning: 'glm-5.3',
    },
  },
  {
    // Migrated from the bespoke MoonshotProvider class. Model ids verified
    // against the OpenRouter moonshotai listing (2026-10).
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    labelKey: 'providerMoonshot',
    badge: 'KIMI',
    apiFormat: 'openai_chat',
    baseUrl: 'https://api.moonshot.ai/v1',
    website: 'https://platform.moonshot.ai',
    keyHint: 'sk-...',
    nativeModelPrefixes: ['kimi', 'moonshot'],
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'],
    tiers: {
      flagship: 'kimi-k3',
      standard: 'kimi-k2.6',
      fast: 'kimi-k2.7-code-highspeed',
      reasoning: 'kimi-k3',
    },
  },
  {
    // Migrated from the bespoke MiniMaxProvider class. Model ids verified
    // against the OpenRouter minimax listing (2026-10): m3 is the current
    // flagship, m2.7 the current workhorse.
    id: 'minimax',
    label: 'MiniMax',
    labelKey: 'providerMinimax',
    badge: 'MM',
    apiFormat: 'openai_chat',
    baseUrl: 'https://api.minimax.io/v1',
    website: 'https://platform.minimax.io',
    keyHint: '...',
    nativeModelPrefixes: ['minimax'],
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2'],
    tiers: {
      flagship: 'MiniMax-M3',
      standard: 'MiniMax-M2.7',
      fast: 'MiniMax-M2.7-highspeed',
      reasoning: 'MiniMax-M3',
    },
  },
  {
    // ClinePass — Cline's flat subscription ($9.99/mo) for open-weight models
    // (GLM, Kimi, DeepSeek, MiMo, MiniMax, Qwen) via api.cline.bot. OpenAI
    // chat-compatible only upstream — no native Anthropic endpoint — but the
    // generic provider's Anthropic bridge serves /v1/messages anyway, so
    // Claude Code clients work through translation. Every model id carries the
    // mandatory `cline-pass/` slug prefix upstream, so native passthrough is a
    // single prefix. Prices in `pricing` are reference rates used for quota
    // measurement, not per-token billing (the subscription is flat).
    // https://docs.cline.bot/getting-started/clinepass
    id: 'clinepass',
    label: 'ClinePass',
    labelKey: 'providerClinepass',
    badge: 'CPASS',
    apiFormat: 'openai_chat',
    baseUrl: 'https://api.cline.bot/api/v1',
    website: 'https://app.cline.bot',
    keyHint: 'API key (app.cline.bot → Settings → API Keys)',
    nativeModelPrefixes: ['cline-pass/'],
    models: [
      'cline-pass/glm-5.3',
      'cline-pass/glm-5.3-flash',
      'cline-pass/kimi-k3',
      'cline-pass/deepseek-v4-pro',
      'cline-pass/deepseek-v4.1-flash',
      'cline-pass/mimo-v2.5',
      'cline-pass/mimo-v2.5-pro',
      'cline-pass/minimax-m3',
      'cline-pass/qwen3.7-max',
      'cline-pass/qwen3.7-plus',
      'cline-pass/qwen3.8-max',
      'cline-pass/muse-spark-1.3-contributor',
    ],
    tiers: {
      flagship: 'cline-pass/kimi-k3',
      standard: 'cline-pass/glm-5.3',
      fast: 'cline-pass/glm-5.3-flash',
      reasoning: 'cline-pass/mimo-v2.5-pro',
    },
    pricing: {
      'cline-pass/glm-5.3': { input: 1.40, output: 4.40, cacheRead: 0.26 },
      'cline-pass/glm-5.3-flash': { input: 0.15, output: 0.50, cacheRead: 0.03 },
      'cline-pass/kimi-k3': { input: 3.00, output: 15.00, cacheRead: 0.30 },
      'cline-pass/deepseek-v4-pro': { input: 1.32, output: 3.96, cacheRead: 0.044 },
      'cline-pass/deepseek-v4.1-flash': { input: 0.30, output: 1.20, cacheRead: 0.006 },
      'cline-pass/mimo-v2.5': { input: 0.14, output: 0.28, cacheRead: 0.0028 },
      'cline-pass/mimo-v2.5-pro': { input: 1.74, output: 3.48, cacheRead: 0.0145 },
      'cline-pass/minimax-m3': { input: 0.30, output: 1.20, cacheRead: 0.06 },
      'cline-pass/qwen3.7-max': { input: 2.50, output: 7.50, cacheRead: 0.50, cacheWrite: 3.125 },
      'cline-pass/qwen3.7-plus': { input: 0.40, output: 1.60, cacheRead: 0.04, cacheWrite: 0.50 },
      'cline-pass/qwen3.8-max': { input: 2.00, output: 6.00, cacheRead: 0.25, cacheWrite: 2.50 },
      'cline-pass/muse-spark-1.3-contributor': { input: 0.10, output: 0.20, cacheRead: 0.002 },
    },
  },
  {
    // Ollama Cloud — hosted models served from ollama.com (no local install
    // needed, unlike the local Ollama runtime which is a separate mechanism
    // and owns the `ollama` provider id — hence `ollama-cloud` here).
    // OpenAI-compatible /v1 (chat/completions + /models). Cloud model ids mix
    // bare vendor names (glm-5.3, kimi-k3) and tagged ones (gpt-oss:120b), so
    // passthrough combines a family-prefix list (kept exact — `gpt-oss`, not
    // `gpt`, or incoming gpt-5.x from Codex would stop remapping) with a `:`
    // match for tag-style ids. Prices from ollama.com (USD / 1M tokens).
    // https://docs.ollama.com/api/openai-compatibility
    id: 'ollama-cloud',
    label: 'Ollama Cloud',
    labelKey: 'providerOllamaCloud',
    badge: 'OLLAMA',
    apiFormat: 'openai_chat',
    baseUrl: 'https://ollama.com/v1',
    website: 'https://ollama.com',
    keyHint: 'API key (ollama.com/settings/keys)',
    nativeModelPrefixes: ['gpt-oss', 'glm', 'kimi', 'deepseek', 'minimax', 'gemma', 'mistral', 'nemotron', 'qwen', 'llama', 'phi', 'granite'],
    passthroughModelMatch: ':',
    models: [
      'glm-5.3',
      'glm-5.3-flash',
      'kimi-k3',
      'deepseek-v4-pro',
      'glm-5.2',
      'kimi-k2.7-code',
      'kimi-k2.6',
      'deepseek-v4.1-flash',
      'minimax-m3',
      'minimax-m2.7',
      'gpt-oss:120b',
      'gpt-oss:20b',
      'gemma4',
      'mistral-large-4',
      'nemotron-3-ultra',
      'nemotron-3-super',
      'nemotron-3-nano',
    ],
    tiers: {
      flagship: 'kimi-k3',
      standard: 'glm-5.3',
      fast: 'glm-5.3-flash',
      reasoning: 'deepseek-v4-pro',
    },
    pricing: {
      'glm-5.3': { input: 1.40, output: 4.40, cacheRead: 0.26 },
      'glm-5.3-flash': { input: 0.15, output: 0.50, cacheRead: 0.03 },
      'glm-5.2': { input: 1.40, output: 4.40, cacheRead: 0.26 },
      'kimi-k3': { input: 3.00, output: 15.00, cacheRead: 0.30 },
      'kimi-k2.7-code': { input: 0.95, output: 4.00, cacheRead: 0.19 },
      'kimi-k2.6': { input: 0.95, output: 4.00, cacheRead: 0.16 },
      'deepseek-v4-pro': { input: 1.32, output: 3.96, cacheRead: 0.044 },
      'deepseek-v4.1-flash': { input: 0.30, output: 1.20, cacheRead: 0.006 },
      'minimax-m3': { input: 0.60, output: 2.40, cacheRead: 0.12 },
      'minimax-m2.7': { input: 0.30, output: 1.20, cacheRead: 0.06 },
      'gpt-oss:120b': { input: 0.15, output: 0.60, cacheRead: 0.014 },
      'gpt-oss:20b': { input: 0.07, output: 0.30, cacheRead: 0.035 },
      'gemma4': { input: 0.14, output: 0.40, cacheRead: 0.05 },
      'mistral-large-4': { input: 0.68, output: 2.09, cacheRead: 0.07 },
      'nemotron-3-ultra': { input: 0.10, output: 3.00, cacheRead: 0.10 },
      'nemotron-3-super': { input: 0.015, output: 0.60, cacheRead: 0.015 },
      'nemotron-3-nano': { input: 0.06, output: 0.24, cacheRead: 0 },
    },
  },
];

// ─── User-defined presets (~/.cligate/provider-presets.json) ────────────────

const USER_PRESETS_FILE = join(CONFIG_DIR, 'provider-presets.json');
const PRESET_API_FORMATS = new Set(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native']);
const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const PRESET_TIER_KEYS = ['flagship', 'standard', 'fast', 'reasoning'];

function userPresetProblem(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return 'entry must be an object';
  }
  if (typeof entry.id !== 'string' || !PRESET_ID_PATTERN.test(entry.id)) {
    return `invalid id "${entry.id}" (expected lowercase letters/digits/dots/dashes)`;
  }
  if (BUILTIN_PRESET_IDS.has(entry.id)) {
    return `id "${entry.id}" collides with a built-in preset and is ignored`;
  }
  if (typeof entry.baseUrl !== 'string' || !entry.baseUrl.trim()) {
    return `preset "${entry.id}": baseUrl is required`;
  }
  if (entry.apiFormat !== undefined && !PRESET_API_FORMATS.has(entry.apiFormat)) {
    return `preset "${entry.id}": apiFormat must be one of ${[...PRESET_API_FORMATS].join(', ')}`;
  }
  if (entry.models !== undefined && (!Array.isArray(entry.models) || entry.models.some((m) => typeof m !== 'string'))) {
    return `preset "${entry.id}": models must be an array of strings`;
  }
  if (entry.tiers !== undefined) {
    if (!entry.tiers || typeof entry.tiers !== 'object' || Array.isArray(entry.tiers)) {
      return `preset "${entry.id}": tiers must be an object`;
    }
    for (const [tier, model] of Object.entries(entry.tiers)) {
      if (!PRESET_TIER_KEYS.includes(tier)) return `preset "${entry.id}": unknown tier "${tier}"`;
      if (typeof model !== 'string' || !model.trim()) return `preset "${entry.id}": tier "${tier}" must map to a model id`;
    }
  }
  if (entry.nativeModelPrefixes !== undefined
    && (!Array.isArray(entry.nativeModelPrefixes) || entry.nativeModelPrefixes.some((p) => typeof p !== 'string'))) {
    return `preset "${entry.id}": nativeModelPrefixes must be an array of strings`;
  }
  if (entry.passthroughModelMatch !== undefined && typeof entry.passthroughModelMatch !== 'string') {
    return `preset "${entry.id}": passthroughModelMatch must be a string`;
  }
  if (entry.validateModel !== undefined && (typeof entry.validateModel !== 'string' || !entry.validateModel.trim())) {
    return `preset "${entry.id}": validateModel must be a non-empty string`;
  }
  return null;
}

function normalizeUserPreset(entry) {
  return {
    label: entry.label || entry.id,
    badge: entry.badge || entry.id.slice(0, 2).toUpperCase(),
    apiFormat: entry.apiFormat || 'openai_chat',
    ...entry,
  };
}

function loadUserPresets() {
  if (!existsSync(USER_PRESETS_FILE)) return [];

  try {
    const parsed = JSON.parse(readFileSync(USER_PRESETS_FILE, 'utf8'));
    const entries = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.presets) ? parsed.presets : null);
    if (!entries) {
      console.warn(`[ProviderPresets] ${USER_PRESETS_FILE} must contain an array of presets (or { presets: [...] }) — ignored`);
      return [];
    }

    const seen = new Set();
    const result = [];
    for (const entry of entries) {
      const problem = userPresetProblem(entry);
      if (problem) {
        console.warn(`[ProviderPresets] Skipping user preset: ${problem}`);
        continue;
      }
      if (seen.has(entry.id)) {
        console.warn(`[ProviderPresets] Skipping duplicate user preset id "${entry.id}"`);
        continue;
      }
      seen.add(entry.id);
      result.push(normalizeUserPreset(entry));
    }
    return result;
  } catch (err) {
    console.warn(`[ProviderPresets] Failed to load ${USER_PRESETS_FILE}: ${err.message} — user presets ignored`);
    return [];
  }
}

// Built-ins first, user entries after. Ids are unique across the merged list
// (enforced above), so PRESET_BY_ID keeps first-wins semantics for built-ins.
const BUILTIN_PRESET_IDS = new Set(PROVIDER_PRESETS.map((p) => p.id));
PROVIDER_PRESETS.push(...loadUserPresets());

export const PRESET_BY_ID = Object.fromEntries(PROVIDER_PRESETS.map((p) => [p.id, p]));

/** All preset provider ids. */
export const presetIds = () => PROVIDER_PRESETS.map((p) => p.id);

/** Preset ids whose apiFormat is one of the given formats. */
export const presetIdsByFormat = (...formats) =>
  PROVIDER_PRESETS.filter((p) => formats.includes(p.apiFormat)).map((p) => p.id);

/** { id: pricingTable } for presets that declare pricing. */
export const presetPricing = () =>
  Object.fromEntries(PROVIDER_PRESETS.filter((p) => p.pricing).map((p) => [p.id, p.pricing]));

/** { id: tierMap } for presets that declare tier mappings. */
export const presetTierMappings = () =>
  Object.fromEntries(PROVIDER_PRESETS.filter((p) => p.tiers).map((p) => [p.id, p.tiers]));

/** { id: [modelId] } for presets that declare a model list. */
export const presetStaticModels = () =>
  Object.fromEntries(PROVIDER_PRESETS.filter((p) => p.models).map((p) => [p.id, p.models]));

/** Lightweight list for the dashboard add-key form. */
export const presetUiList = () =>
  PROVIDER_PRESETS.map(({ id, label, labelKey, badge, baseUrl, keyHint, website }) => ({
    id,
    label,
    labelKey,
    badge,
    baseUrl,
    keyHint,
    website,
  }));

export default {
  PROVIDER_PRESETS,
  PRESET_BY_ID,
  presetIds,
  presetIdsByFormat,
  presetPricing,
  presetTierMappings,
  presetStaticModels,
  presetUiList,
};
