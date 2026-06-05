/**
 * Generic OpenAI-compatible provider, driven by a preset entry from
 * `provider-presets.js`. Covers the common case where a vendor only differs
 * from OpenAI by base URL, model names, and pricing — so no bespoke class is
 * needed.
 *
 * Surfaces (see docs/multi-provider-integration.zh-CN.md):
 *   - OpenAI chat path (`/v1/chat/completions`, gateway): inherited `sendRequest`.
 *   - Claude Code (`/v1/messages`): `sendAnthropicRequest` below translates
 *     Anthropic Messages ⇄ OpenAI Chat (non-streaming upstream; messages-route
 *     synthesizes Anthropic SSE downstream when the client streams).
 *   - Codex (`/responses`): served by responses-route's EXISTING generic
 *     chat-completions fallback. We deliberately leave `sendResponsesRequest`
 *     undefined so `providerSupportsNativeResponses()` stays false and the route
 *     takes that fallback (these vendors have no native `/responses` endpoint).
 *
 * Only instantiated for preset providers (Qwen, OpenRouter); the bespoke
 * providers (openai/anthropic/gemini/deepseek/…) are untouched.
 */

import { OpenAIProvider } from './openai.js';
import { estimateCostWithRegistry, getDefaultPricing } from '../pricing-registry.js';
import { translateAnthropicToOpenAIChatRequest } from '../translators/request/anthropic-to-openai-chat.js';
import { translateOpenAIChatToAnthropicMessage } from '../translators/response/openai-chat-to-anthropic.js';

/**
 * Build a concrete provider class bound to a preset.
 * @param {object} preset - an entry from PROVIDER_PRESETS
 * @returns {typeof OpenAIProvider}
 */
export function makeOpenAICompatibleProvider(preset) {
  return class OpenAICompatibleProvider extends OpenAIProvider {
    constructor(config) {
      super({ ...config, baseUrl: config.baseUrl || preset.baseUrl });
      this.type = preset.id;

      // Chat-completions-only vendors expose no native `/responses`. Leaving
      // sendResponsesRequest undefined routes Codex through responses-route's
      // chat fallback (Responses⇄Chat), which already buffers + synthesizes SSE.
      // (OpenAIProvider's inherited sendResponsesRequest would POST to a
      // nonexistent `/responses` endpoint.)
      this.sendResponsesRequest = undefined;
    }

    /**
     * Serve Anthropic Messages (Claude Code) by translating to/from OpenAI Chat.
     * Returns a fetch-style Response carrying an Anthropic-format JSON body, or
     * the raw upstream Response on error (handled by messages-route).
     *
     * Overrides OpenAIProvider.sendAnthropicRequest (which targets `/responses`)
     * with a chat-completions implementation suited to these vendors.
     */
    async sendAnthropicRequest(body = {}) {
      const { _proxypoolAppId, ...anthropicBody } = body;
      const chatBody = translateAnthropicToOpenAIChatRequest(anthropicBody);
      const response = await this.sendRequest(chatBody);
      if (!response.ok) return response;

      const chatData = await response.json();
      const anthropicMessage = translateOpenAIChatToAnthropicMessage(chatData, { model: anthropicBody.model });
      return new Response(JSON.stringify(anthropicMessage), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    estimateCost(model, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
      return estimateCostWithRegistry(this.type, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
    }

    static get pricing() {
      return getDefaultPricing(preset.id);
    }
  };
}

export default makeOpenAICompatibleProvider;
