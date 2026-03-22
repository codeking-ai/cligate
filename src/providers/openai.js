/**
 * OpenAI Provider
 * Forwards requests to OpenAI API using API keys.
 */

import { BaseProvider } from './base.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

// Pricing per 1M tokens (USD) — approximate, updated as needed
const PRICING = {
    'gpt-4o':          { input: 2.50, output: 10.00 },
    'gpt-4o-mini':     { input: 0.15, output: 0.60 },
    'gpt-4-turbo':     { input: 10.00, output: 30.00 },
    'gpt-4':           { input: 30.00, output: 60.00 },
    'gpt-3.5-turbo':   { input: 0.50, output: 1.50 },
    'o1':              { input: 15.00, output: 60.00 },
    'o1-mini':         { input: 3.00, output: 12.00 },
    'o3':              { input: 10.00, output: 40.00 },
    'o3-mini':         { input: 1.10, output: 4.40 },
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

    static get pricing() {
        return PRICING;
    }
}

export default OpenAIProvider;
