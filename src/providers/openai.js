/**
 * OpenAI Provider
 * Forwards requests to OpenAI API using API keys.
 * Also supports Anthropic Messages API passthrough via format conversion.
 */

import { BaseProvider } from './base.js';
import { anthropicToOpenAI, openAIToAnthropic } from './format-bridge.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

// Pricing per 1M tokens (USD) — approximate, updated as needed
const PRICING = {
    'gpt-5.4':         { input: 2.50, output: 15.00 },
    'gpt-5.4-pro':     { input: 30.00, output: 180.00 },
    'gpt-5.4-mini':    { input: 0.75, output: 4.50 },
    'gpt-5.4-nano':    { input: 0.20, output: 1.25 },
    'gpt-5.3-codex':   { input: 2.50, output: 10.00 },
    'gpt-5.2':         { input: 1.75, output: 14.00 },
    'gpt-4o':          { input: 2.50, output: 10.00 },
    'gpt-4o-mini':     { input: 0.15, output: 0.60 },
    'o3':              { input: 2.00, output: 8.00 },
    'o3-pro':          { input: 20.00, output: 80.00 },
    'o4-mini':         { input: 1.10, output: 4.40 },
};

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
        const pricing = PRICING[model];
        if (!pricing) return 0;
        return (inputTokens / 1_000_000) * pricing.input +
               (outputTokens / 1_000_000) * pricing.output;
    }

    // ─── Anthropic Messages API passthrough (for /v1/messages endpoint) ──────

    /**
     * Accept an Anthropic Messages API body, convert to OpenAI Chat Completions,
     * send to OpenAI, and return response in Anthropic Messages format.
     */
    async sendAnthropicRequest(body) {
        const openaiBody = anthropicToOpenAI(body);
        const url = `${this.baseUrl}/chat/completions`;
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
        const anthropicResponse = openAIToAnthropic(data, body.model);

        return new Response(JSON.stringify(anthropicResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    static get pricing() {
        return PRICING;
    }
}

export default OpenAIProvider;
