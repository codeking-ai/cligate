/**
 * OpenAI Chat Completions → Anthropic Messages (response)
 *
 * Isolated translator used ONLY by the generic OpenAICompatibleProvider to turn
 * a chat-completions reply (Qwen / OpenRouter) back into an Anthropic Messages
 * response for Claude Code. Non-streaming only — messages-route synthesizes SSE
 * downstream when needed.
 */

import crypto from 'crypto';

export const SOURCE_PROTOCOL = 'openai-chat';
export const TARGET_PROTOCOL = 'anthropic-messages';

export function generateMessageId() {
    return `msg_${crypto.randomBytes(16).toString('hex')}`;
}

function mapStopReason(finishReason, hasToolUse) {
    if (hasToolUse) return 'tool_use';
    switch (finishReason) {
        case 'length': return 'max_tokens';
        case 'tool_calls':
        case 'function_call': return 'tool_use';
        case 'content_filter': return 'end_turn';
        case 'stop':
        default: return 'end_turn';
    }
}

function parseToolArguments(raw) {
    if (raw == null || raw === '') return {};
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        // Some providers stream partial / non-JSON arguments; preserve as raw text.
        return { __raw: String(raw) };
    }
}

export function translateOpenAIChatToAnthropicMessage(chatResponse = {}, context = {}) {
    const model = context.model || chatResponse.model || 'unknown';
    const choice = Array.isArray(chatResponse.choices) ? chatResponse.choices[0] : null;
    const message = choice?.message || {};

    const content = [];

    if (typeof message.content === 'string' && message.content.length > 0) {
        content.push({ type: 'text', text: message.content });
    } else if (Array.isArray(message.content)) {
        // Some OpenAI-compatible vendors return content parts; flatten text parts.
        const text = message.content
            .map((part) => (typeof part === 'string' ? part : part?.text || ''))
            .filter(Boolean)
            .join('');
        if (text) content.push({ type: 'text', text });
    }

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const tc of toolCalls) {
        if (!tc) continue;
        content.push({
            type: 'tool_use',
            id: tc.id || `toolu_${crypto.randomBytes(12).toString('hex')}`,
            name: tc.function?.name || tc.name || 'unknown',
            input: parseToolArguments(tc.function?.arguments)
        });
    }

    if (content.length === 0) {
        content.push({ type: 'text', text: '' });
    }

    const usage = chatResponse.usage || {};

    return {
        id: chatResponse.id ? `msg_${String(chatResponse.id).replace(/^chatcmpl[-_]?/, '')}` : generateMessageId(),
        type: 'message',
        role: 'assistant',
        content,
        model,
        stop_reason: mapStopReason(choice?.finish_reason, toolCalls.length > 0),
        stop_sequence: null,
        usage: {
            input_tokens: usage.prompt_tokens || 0,
            output_tokens: usage.completion_tokens || 0,
            cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
            cache_creation_input_tokens: 0
        }
    };
}

export default {
    SOURCE_PROTOCOL,
    TARGET_PROTOCOL,
    generateMessageId,
    translateOpenAIChatToAnthropicMessage
};
