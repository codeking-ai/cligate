/**
 * Format Bridge: Anthropic Messages API <-> OpenAI Chat Completions API
 * Converts request/response formats between the two APIs.
 */

import {
    convertAnthropicToolChoiceToOpenAIChat,
    convertAnthropicToolsToOpenAIChat
} from '../translators/normalizers/tools.js';

/**
 * Convert Anthropic Messages request body to OpenAI Chat Completions format.
 * @param {object} body - Anthropic Messages API request body
 * @returns {object} OpenAI Chat Completions request body
 */
export function anthropicToOpenAI(body) {
    const messages = [];

    // System prompt
    if (body.system) {
        const systemText = typeof body.system === 'string'
            ? body.system
            : Array.isArray(body.system)
                ? body.system.filter(b => b.type === 'text').map(b => b.text).join('\n')
                : '';
        if (systemText) {
            messages.push({ role: 'system', content: systemText });
        }
    }

    // Convert messages
    for (const msg of (body.messages || [])) {
        if (msg.role === 'user' || msg.role === 'system') {
            messages.push(..._convertUserMessageToOpenAI(msg.role, msg.content));
        } else if (msg.role === 'assistant') {
            const result = _convertAssistantToOpenAI(msg.content);
            messages.push(result);
        }
    }

    const openaiBody = {
        model: body.model || 'gpt-4o',
        messages,
        max_completion_tokens: body.max_tokens || 8192
    };

    if (body.temperature !== undefined) openaiBody.temperature = body.temperature;
    if (body.top_p !== undefined) openaiBody.top_p = body.top_p;
    if (body.stop_sequences) openaiBody.stop = body.stop_sequences;

    const { canonicalTools, tools } = convertAnthropicToolsToOpenAIChat(body.tools, {
        unsupportedHostedToolsAction: 'omit'
    });
    if (tools.length > 0) {
        openaiBody.tools = tools;
    }

    const { value: toolChoice } = convertAnthropicToolChoiceToOpenAIChat(
        body.tool_choice,
        canonicalTools,
        { fallbackValue: 'auto' }
    );
    if (toolChoice !== undefined) {
        openaiBody.tool_choice = toolChoice;
    }

    return openaiBody;
}

/**
 * Convert OpenAI Chat Completions response to Anthropic Messages format.
 * @param {object} data - OpenAI Chat Completions response
 * @param {string} originalModel - The model name to include in the response
 * @returns {object} Anthropic Messages response
 */
export function openAIToAnthropic(data, originalModel) {
    const choice = data.choices?.[0];
    const message = choice?.message || {};
    const content = [];

    // Text content
    if (typeof message.content === 'string' && message.content) {
        content.push({ type: 'text', text: message.content });
    } else if (Array.isArray(message.content)) {
        const text = message.content
            .filter(part => part?.type === 'text' && typeof part.text === 'string')
            .map(part => part.text)
            .join('');
        if (text) {
            content.push({ type: 'text', text });
        }
    }

    // Tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
        for (const tc of message.tool_calls) {
            if (tc.type === 'function') {
                let input = {};
                try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
                content.push({
                    type: 'tool_use',
                    id: tc.id || `toolu_${Date.now()}`,
                    name: tc.function.name,
                    input
                });
            }
        }
    }

    if (content.length === 0) {
        content.push({ type: 'text', text: '' });
    }

    // Map finish_reason
    let stop_reason = 'end_turn';
    const fr = choice?.finish_reason;
    if (fr === 'tool_calls' || fr === 'function_call') stop_reason = 'tool_use';
    else if (fr === 'length') stop_reason = 'max_tokens';
    else if (fr === 'content_filter') stop_reason = 'end_turn';
    else if (fr === 'stop') stop_reason = 'end_turn';

    return {
        id: data.id || `msg_bridge_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content,
        model: originalModel || data.model,
        stop_reason,
        stop_sequence: null,
        usage: {
            input_tokens: data.usage?.prompt_tokens || 0,
            output_tokens: data.usage?.completion_tokens || 0
        }
    };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function _convertContentToOpenAI(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';

    const parts = [];
    for (const block of content) {
        if (block.type === 'text') {
            parts.push(block.text);
        } else if (block.type === 'tool_result') {
            // tool_result in user messages — flatten to text
            const resultText = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                    ? block.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
                    : JSON.stringify(block.content);
            parts.push(resultText);
        } else if (block.type === 'image') {
            // Skip images for text-only models; could be extended
            parts.push('[image]');
        }
    }
    return parts.join('\n');
}

function _anthropicImageToOpenAI(block) {
    const source = block?.source || {};
    if (source.type === 'base64' && source.data) {
        return {
            type: 'image_url',
            image_url: {
                url: `data:${source.media_type || 'image/jpeg'};base64,${source.data}`
            }
        };
    }
    if (source.type === 'url' && source.url) {
        return {
            type: 'image_url',
            image_url: {
                url: source.url
            }
        };
    }
    return null;
}

function _convertUserMessageToOpenAI(role, content) {
    if (typeof content === 'string') {
        return [{ role, content }];
    }
    if (!Array.isArray(content)) {
        return [{ role, content: '' }];
    }

    const richParts = [];
    const textParts = [];
    const toolMessages = [];

    for (const block of content) {
        if (!block) continue;

        if (block.type === 'text') {
            const text = block.text || '';
            textParts.push(text);
            richParts.push({ type: 'text', text });
            continue;
        }

        if (block.type === 'image') {
            const imagePart = _anthropicImageToOpenAI(block);
            if (imagePart) richParts.push(imagePart);
            continue;
        }

        if (block.type === 'tool_result') {
            const resultText = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                    ? block.content
                        .filter(item => item?.type === 'text')
                        .map(item => item.text || '')
                        .join('\n')
                    : JSON.stringify(block.content ?? '');

            toolMessages.push({
                role: 'tool',
                tool_call_id: block.tool_use_id,
                content: block.is_error ? `Error: ${resultText}` : resultText
            });
        }
    }

    const result = [...toolMessages];
    if (richParts.length > 0) {
        const hasOnlyText = richParts.every(part => part.type === 'text');
        result.push({
            role,
            content: hasOnlyText ? textParts.join('\n') : richParts
        });
    }

    if (result.length === 0) {
        result.push({ role, content: '' });
    }

    return result;
}

function _convertAssistantToOpenAI(content) {
    if (typeof content === 'string') {
        return { role: 'assistant', content };
    }
    if (!Array.isArray(content)) {
        return { role: 'assistant', content: '' };
    }

    const textParts = [];
    const toolCalls = [];

    for (const block of content) {
        if (block.type === 'text') {
            textParts.push(block.text);
        } else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id || `call_${Date.now()}`,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input || {})
                }
            });
        }
        // Skip thinking blocks
    }

    const result = { role: 'assistant', content: textParts.join('\n') || null };
    if (toolCalls.length > 0) {
        result.tool_calls = toolCalls;
    }
    return result;
}

export default { anthropicToOpenAI, openAIToAnthropic };
