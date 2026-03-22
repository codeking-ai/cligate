/**
 * Anthropic Provider
 * Forwards requests to Anthropic API using API keys.
 */

import { BaseProvider } from './base.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

const PRICING = {
    'claude-sonnet-4-5-20250514':  { input: 3.00, output: 15.00 },
    'claude-opus-4-5-20250514':    { input: 15.00, output: 75.00 },
    'claude-haiku-4-5-20251001':   { input: 0.80, output: 4.00 },
    'claude-3-5-sonnet-20241022':  { input: 3.00, output: 15.00 },
    'claude-3-5-haiku-20241022':   { input: 0.80, output: 4.00 },
    'claude-3-opus-20240229':      { input: 15.00, output: 75.00 },
};

// Aliases for convenience
const MODEL_ALIASES = {
    'claude-sonnet-4-5': 'claude-sonnet-4-5-20250514',
    'claude-opus-4-5': 'claude-opus-4-5-20250514',
    'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};

export class AnthropicProvider extends BaseProvider {
    constructor(config) {
        super({
            ...config,
            type: 'anthropic',
            baseUrl: config.baseUrl || DEFAULT_BASE_URL
        });
    }

    async sendRequest(body, { stream = false } = {}) {
        const url = `${this.baseUrl}/v1/messages`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': API_VERSION,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        return response;
    }

    async validateKey() {
        try {
            // Send a minimal request to check key validity
            const response = await fetch(`${this.baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': API_VERSION,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'hi' }]
                })
            });
            // 200 or 400 (bad request) means key is valid; 401 means invalid
            return response.status !== 401;
        } catch {
            return false;
        }
    }

    estimateCost(model, inputTokens, outputTokens) {
        const resolvedModel = MODEL_ALIASES[model] || model;
        const pricing = PRICING[resolvedModel];
        if (!pricing) return 0;
        return (inputTokens / 1_000_000) * pricing.input +
               (outputTokens / 1_000_000) * pricing.output;
    }

    static get pricing() {
        return PRICING;
    }
}

export default AnthropicProvider;
