/**
 * Vertex AI Provider
 * Forwards requests to Google Cloud Vertex AI endpoints.
 *
 * Required config:
 *   - apiKey:     OAuth2 Bearer token or API key
 *   - projectId:  GCP project ID
 *   - location:   Region, e.g. us-central1
 *
 * URL format:
 *   https://{location}-aiplatform.googleapis.com/v1/projects/{projectId}/locations/{location}/publishers/google/models/{model}:generateContent
 */

import { BaseProvider } from './base.js';

const PRICING = {
    'gemini-3.1-pro-preview':        { input: 2.00, output: 12.00 },
    'gemini-3-flash-preview':        { input: 0.50, output: 3.00 },
    'gemini-3.1-flash-lite-preview': { input: 0.25, output: 1.50 },
    'gemini-2.5-pro':                { input: 1.25, output: 10.00 },
    'gemini-2.5-flash':              { input: 0.15, output: 0.60 },
    'gemini-2.0-flash':              { input: 0.10, output: 0.40 },
    'claude-opus-4-6':               { input: 15.00, output: 75.00 },
    'claude-sonnet-4-6':             { input: 3.00, output: 15.00 },
    'claude-sonnet-4-5':             { input: 3.00, output: 15.00 },
    'claude-haiku-4-5':              { input: 0.80, output: 4.00 },
};

const DEFAULT_MODEL = 'gemini-3-flash-preview';

export class VertexAIProvider extends BaseProvider {
    constructor(config) {
        super({
            ...config,
            type: 'vertex-ai',
            baseUrl: config.baseUrl || ''
        });
        this.projectId = config.projectId || '';
        this.location = config.location || 'us-central1';
    }

    /**
     * Build Vertex AI endpoint URL for a given model.
     */
    _buildUrl(model) {
        return `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${model}:generateContent`;
    }

    /**
     * Determine auth headers based on key format.
     */
    _authHeaders() {
        // OAuth tokens start with ya29. or are very long (JWT)
        if (this.apiKey.startsWith('ya29.') || this.apiKey.length > 200) {
            return { 'Authorization': `Bearer ${this.apiKey}` };
        }
        return {};
    }

    /**
     * Build URL with API key appended if not using Bearer auth.
     */
    _authUrl(url) {
        if (this.apiKey.startsWith('ya29.') || this.apiKey.length > 200) {
            return url;
        }
        const separator = url.includes('?') ? '&' : '?';
        return `${url}${separator}key=${this.apiKey}`;
    }

    /**
     * Convert OpenAI messages to Gemini contents format.
     * Handles text, tool_calls (assistant→functionCall), and tool results (tool→functionResponse).
     */
    _convertMessages(messages) {
        const contents = [];
        let systemInstruction = null;

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];

            if (msg.role === 'system') {
                systemInstruction = { parts: [{ text: msg.content }] };
                continue;
            }

            // Assistant message with tool_calls → convert to plain text summary
            // Gemini 3.x requires thought_signature on functionCall parts which we can't preserve
            // through OpenAI format conversion, so we flatten tool history to text.
            if (msg.role === 'assistant' && msg.tool_calls) {
                const parts = [];
                if (msg.content) parts.push(msg.content);
                for (const tc of msg.tool_calls) {
                    parts.push(`[Called function: ${tc.function.name}(${tc.function.arguments || '{}'})]`);
                }
                contents.push({ role: 'model', parts: [{ text: parts.join('\n') }] });
                continue;
            }

            // Tool result message → convert to plain text
            if (msg.role === 'tool') {
                const name = msg.name || 'unknown';
                contents.push({
                    role: 'user',
                    parts: [{ text: `[Function ${name} returned: ${msg.content || ''}]` }]
                });
                continue;
            }

            contents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }]
            });
        }

        // Gemini requires alternating user/model roles — merge consecutive same-role messages
        const merged = [];
        for (const c of contents) {
            if (merged.length > 0 && merged[merged.length - 1].role === c.role) {
                merged[merged.length - 1].parts.push(...c.parts);
            } else {
                merged.push({ ...c, parts: [...c.parts] });
            }
        }

        return { contents: merged, systemInstruction };
    }

    /**
     * Strip fields unsupported by Gemini from JSON Schema (e.g. additionalProperties).
     */
    _cleanSchema(schema) {
        if (!schema || typeof schema !== 'object') return schema;
        if (Array.isArray(schema)) return schema.map(s => this._cleanSchema(s));
        const cleaned = {};
        for (const [key, value] of Object.entries(schema)) {
            if (key === 'additionalProperties') continue;
            cleaned[key] = this._cleanSchema(value);
        }
        return cleaned;
    }

    /**
     * Convert OpenAI tools format to Gemini tools format.
     */
    _convertTools(tools) {
        if (!Array.isArray(tools) || tools.length === 0) return null;
        const functionDeclarations = tools
            .filter(t => t.type === 'function' && t.function)
            .map(t => ({
                name: t.function.name,
                description: t.function.description || '',
                parameters: this._cleanSchema(t.function.parameters || { type: 'object', properties: {} })
            }));
        return functionDeclarations.length > 0 ? [{ functionDeclarations }] : null;
    }

    /**
     * Convert Vertex/Gemini response to OpenAI format.
     * Handles text parts, functionCall parts, and thinking parts.
     */
    _convertResponse(vertexResponse, model) {
        const candidate = vertexResponse.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        const usage = vertexResponse.usageMetadata || {};

        // Extract text (skip thinking parts)
        const textParts = parts.filter(p => p.text !== undefined && !p.thought);
        const text = textParts.map(p => p.text).join('');

        // Extract function calls
        const functionCalls = parts.filter(p => p.functionCall);
        const toolCalls = functionCalls.map((p, i) => ({
            id: `call_${Date.now()}_${i}`,
            type: 'function',
            function: {
                name: p.functionCall.name,
                arguments: JSON.stringify(p.functionCall.args || {})
            }
        }));

        const message = { role: 'assistant', content: text };
        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
        }

        return {
            id: `chatcmpl-vertex-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message,
                finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
            }],
            usage: {
                prompt_tokens: usage.promptTokenCount || 0,
                completion_tokens: usage.candidatesTokenCount || 0,
                total_tokens: usage.totalTokenCount || 0
            }
        };
    }

    async sendRequest(body) {
        const model = body.model || DEFAULT_MODEL;
        const { contents, systemInstruction } = this._convertMessages(body.messages || []);

        const vertexBody = {
            contents,
            generationConfig: {
                maxOutputTokens: body.max_tokens || 8192,
                temperature: body.temperature,
                topP: body.top_p,
            }
        };
        if (systemInstruction) {
            vertexBody.systemInstruction = systemInstruction;
        }

        // Convert and attach tools
        const vertexTools = this._convertTools(body.tools);
        if (vertexTools) {
            vertexBody.tools = vertexTools;
            // Gemini 3.x requires thought_signature round-trip for tool calls with thinking enabled.
            // Since we convert between OpenAI↔Gemini formats, we can't preserve thought signatures,
            // so disable thinking when tools are present.
            vertexBody.generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }

        const url = this._authUrl(this._buildUrl(model));
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...this._authHeaders()
            },
            body: JSON.stringify(vertexBody)
        });

        if (!response.ok) return response;

        const data = await response.json();
        return new Response(JSON.stringify(this._convertResponse(data, model)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async validateKey() {
        try {
            const model = 'gemini-2.0-flash';
            const url = this._authUrl(this._buildUrl(model));
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...this._authHeaders()
                },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
                    generationConfig: { maxOutputTokens: 1 }
                })
            });
            return response.status !== 401 && response.status !== 403;
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

    toJSON() {
        return {
            ...super.toJSON(),
            projectId: this.projectId,
            location: this.location
        };
    }

    static get pricing() {
        return PRICING;
    }
}

export default VertexAIProvider;
