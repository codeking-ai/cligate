/**
 * Provider Presets — single declarative source of truth for additively-onboarded
 * API-key providers.
 *
 * Borrowed (not copied) from cc-switch: a provider is a data entry keyed by
 * `apiFormat`, not a bespoke class. Adding an OpenAI-compatible vendor is a
 * single object here — no new class, no scattered edits.
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
 */

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
];

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
