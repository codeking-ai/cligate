/**
 * Anthropic Messages → OpenAI Chat Completions (request)
 *
 * Isolated translator used ONLY by the generic OpenAICompatibleProvider so that
 * chat-completions-only vendors (Qwen, OpenRouter) can serve Claude Code's
 * `/v1/messages` traffic. It does NOT touch the existing Anthropic↔Responses
 * kernel or any other provider.
 *
 * Scope: non-streaming request bodies. The provider calls the upstream
 * non-streaming; messages-route synthesizes Anthropic SSE downstream when the
 * client asked for a stream.
 */

export const SOURCE_PROTOCOL = 'anthropic-messages';
export const TARGET_PROTOCOL = 'openai-chat';

function systemToText(system) {
    if (!system) return '';
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) {
        return system
            .map((block) => (typeof block === 'string' ? block : block?.text || ''))
            .filter(Boolean)
            .join('\n\n');
    }
    return '';
}

function imageBlockToChat(block) {
    const source = block?.source || {};
    if (source.type === 'base64' && source.data) {
        return { type: 'image_url', image_url: { url: `data:${source.media_type || 'image/jpeg'};base64,${source.data}` } };
    }
    if (source.type === 'url' && source.url) {
        return { type: 'image_url', image_url: { url: source.url } };
    }
    if (typeof source.url === 'string') {
        return { type: 'image_url', image_url: { url: source.url } };
    }
    return null;
}

/** Flatten Anthropic tool_result content (string | block[]) into an OpenAI tool-message string. */
function toolResultToText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((block) => {
                if (typeof block === 'string') return block;
                if (block?.type === 'text') return block.text || '';
                if (block?.type === 'image') return '[image]';
                return block?.text || '';
            })
            .filter(Boolean)
            .join('\n');
    }
    if (typeof content === 'object' && content.text) return content.text;
    return JSON.stringify(content);
}

function normalizeUserContent(content) {
    // Returns either a string (text-only) or an array of OpenAI content parts.
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const block of content) {
        if (!block) continue;
        if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text || '' });
        } else if (block.type === 'image') {
            const img = imageBlockToChat(block);
            if (img) parts.push(img);
        }
        // tool_result blocks are handled separately by the caller.
    }
    if (parts.length === 0) return '';
    if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
    return parts;
}

function mapTools(tools) {
    if (!Array.isArray(tools)) return undefined;
    const mapped = tools
        .filter((tool) => tool && tool.name && tool.input_schema && !tool.type) // skip hosted (typed) tools
        .map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description || '',
                parameters: tool.input_schema || { type: 'object', properties: {} }
            }
        }));
    return mapped.length > 0 ? mapped : undefined;
}

function mapToolChoice(toolChoice) {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === 'string') return toolChoice;
    switch (toolChoice.type) {
        case 'auto': return 'auto';
        case 'any': return 'required';
        case 'tool': return toolChoice.name ? { type: 'function', function: { name: toolChoice.name } } : 'required';
        case 'none': return 'none';
        default: return undefined;
    }
}

export function translateAnthropicToOpenAIChatRequest(body = {}) {
    const messages = [];

    const systemText = systemToText(body.system);
    if (systemText) messages.push({ role: 'system', content: systemText });

    for (const message of Array.isArray(body.messages) ? body.messages : []) {
        if (!message) continue;
        const role = message.role;
        const content = message.content;

        if (role === 'assistant') {
            const textParts = [];
            const toolCalls = [];
            if (typeof content === 'string') {
                if (content) textParts.push(content);
            } else if (Array.isArray(content)) {
                for (const block of content) {
                    if (!block) continue;
                    if (block.type === 'text') {
                        if (block.text) textParts.push(block.text);
                    } else if (block.type === 'tool_use') {
                        toolCalls.push({
                            id: block.id,
                            type: 'function',
                            function: {
                                name: block.name,
                                arguments: JSON.stringify(block.input ?? {})
                            }
                        });
                    }
                    // thinking / redacted_thinking blocks are dropped (no Chat equivalent).
                }
            }
            const assistantMessage = { role: 'assistant', content: textParts.length ? textParts.join('\n\n') : null };
            if (toolCalls.length) assistantMessage.tool_calls = toolCalls;
            messages.push(assistantMessage);
            continue;
        }

        // role === 'user' (or anything else treated as user)
        if (Array.isArray(content)) {
            const toolResults = content.filter((b) => b && b.type === 'tool_result');
            const nonToolBlocks = content.filter((b) => b && b.type !== 'tool_result');

            const userContent = normalizeUserContent(nonToolBlocks);
            const hasUserContent = Array.isArray(userContent) ? userContent.length > 0 : !!userContent;
            if (hasUserContent) messages.push({ role: 'user', content: userContent });

            for (const tr of toolResults) {
                messages.push({
                    role: 'tool',
                    tool_call_id: tr.tool_use_id,
                    content: toolResultToText(tr.content)
                });
            }
        } else {
            messages.push({ role: 'user', content: normalizeUserContent(content) });
        }
    }

    const chatBody = { model: body.model, messages, stream: false };

    if (typeof body.max_tokens === 'number') chatBody.max_tokens = body.max_tokens;
    if (typeof body.temperature === 'number') chatBody.temperature = body.temperature;
    if (typeof body.top_p === 'number') chatBody.top_p = body.top_p;
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) chatBody.stop = body.stop_sequences;

    const tools = mapTools(body.tools);
    if (tools) {
        chatBody.tools = tools;
        const toolChoice = mapToolChoice(body.tool_choice);
        if (toolChoice !== undefined) chatBody.tool_choice = toolChoice;
    }

    return chatBody;
}

export default {
    SOURCE_PROTOCOL,
    TARGET_PROTOCOL,
    translateAnthropicToOpenAIChatRequest
};
