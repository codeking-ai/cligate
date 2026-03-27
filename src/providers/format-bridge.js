/**
 * Format Bridge: Anthropic Messages API <-> OpenAI Chat Completions API
 * Converts request/response formats between the two APIs.
 */

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
            messages.push({ role: msg.role, content: _convertContentToOpenAI(msg.content) });
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

    // Convert Anthropic tools to OpenAI tools
    if (body.tools && body.tools.length > 0) {
        openaiBody.tools = body.tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description || '',
                parameters: tool.input_schema || { type: 'object', properties: {} }
            }
        }));
    }

    if (body.tool_choice) {
        if (body.tool_choice.type === 'any') {
            openaiBody.tool_choice = 'required';
        } else if (body.tool_choice.type === 'auto') {
            openaiBody.tool_choice = 'auto';
        } else if (body.tool_choice.type === 'tool' && body.tool_choice.name) {
            openaiBody.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
        }
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
    if (message.content) {
        content.push({ type: 'text', text: message.content });
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
