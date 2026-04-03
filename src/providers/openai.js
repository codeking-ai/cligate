/**
 * OpenAI Provider
 * Forwards requests to OpenAI API using API keys.
 * Also supports Anthropic Messages API passthrough via translator conversion.
 */

import { BaseProvider } from './base.js';
import { mergeRequestEchoIntoContext } from '../translators/normalizers/request-echo.js';
import { buildTranslatorMetaHeaders, describeTranslatorMeta } from '../translators/normalizers/translator-meta.js';
import { hasHostedAnthropicTools, listHostedAnthropicTools } from '../translators/normalizers/tools.js';
import { translateAnthropicToOpenAIResponsesRequest } from '../translators/request/anthropic-to-openai-responses.js';
import { translateOpenAIResponsesToAnthropicMessage } from '../translators/response/openai-responses-to-anthropic.js';
import { estimateCostWithRegistry, getDefaultPricing } from '../pricing-registry.js';
import { logger } from '../utils/logger.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAIProvider extends BaseProvider {
    constructor(config) {
        super({
            ...config,
            type: 'openai',
            baseUrl: config.baseUrl || DEFAULT_BASE_URL
        });
    }

    async sendRequest(body, { stream = false } = {}) {
        const url = `${this.baseUrl}/chat/completions`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        return response;
    }

    async sendResponsesRequest(body) {
        const url = `${this.baseUrl}/responses`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        return response;
    }

    async listModels() {
        const response = await fetch(`${this.baseUrl}/models`, {
            headers: { 'Authorization': `Bearer ${this.apiKey}` }
        });
        if (!response.ok) return [];
        const data = await response.json();
        return data.data || [];
    }

    async validateKey() {
        try {
            const response = await fetch(`${this.baseUrl}/models`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    estimateCost(model, inputTokens, outputTokens) {
        return estimateCostWithRegistry(this.type, model, inputTokens, outputTokens);
    }

    // ─── Anthropic Messages API passthrough (for /v1/messages endpoint) ──────

    /**
     * Accept an Anthropic Messages API body, convert to OpenAI Responses,
     * send to OpenAI, and return response in Anthropic Messages format.
     */
    async sendAnthropicRequest(body) {
        if (hasHostedAnthropicTools(body.tools)) {
            const hosted = listHostedAnthropicTools(body.tools).map(tool => tool.name || tool.hostedType).join(',');
            return new Response(JSON.stringify({
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: `Hosted Anthropic tools are not supported by the OpenAI Responses bridge. Requested: ${hosted}. Use an Anthropic provider or Vertex Claude rawPredict instead.`
                }
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const openaiBody = translateAnthropicToOpenAIResponsesRequest(body, { stream: false });
        const translatorMeta = describeTranslatorMeta(openaiBody);
        if (translatorMeta.unsupportedTools.length > 0 || translatorMeta.toolChoiceReason) {
            logger.info(
                `[OpenAI] Translator downgrade metadata | model=${body.model || openaiBody.model} | unsupported_tools=${translatorMeta.unsupportedToolNames || '(none)'} | tool_choice_reason=${translatorMeta.toolChoiceReason || '(none)'}`
            );
        }
        const url = `${this.baseUrl}/responses`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(openaiBody)
        });

        if (!response.ok) return response;

        const data = await response.json();
        const anthropicResponse = translateOpenAIResponsesToAnthropicMessage(
            data,
            mergeRequestEchoIntoContext({ model: body.model }, openaiBody)
        );
        const metaHeaders = buildTranslatorMetaHeaders(openaiBody);

        return new Response(JSON.stringify(anthropicResponse), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                ...metaHeaders
            }
        });
    }

    static get pricing() {
        return getDefaultPricing('openai');
    }
}

export default OpenAIProvider;
