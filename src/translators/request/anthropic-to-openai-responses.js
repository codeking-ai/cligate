import { extractSystemPrompt, convertAnthropicMessagesToResponsesInput } from '../normalizers/anthropic-messages.js';
import { sanitizeToolSchema } from '../normalizers/schemas.js';

export const SOURCE_PROTOCOL = 'anthropic-messages';
export const TARGET_PROTOCOL = 'openai-responses';

function convertAnthropicToolsToOpenAI(tools) {
    if (!Array.isArray(tools)) {
        return [];
    }

    return tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        parameters: sanitizeToolSchema(tool.input_schema || { type: 'object' })
    }));
}

export function translateAnthropicToOpenAIResponsesRequest(anthropicRequest, context = {}) {
    const instructions = extractSystemPrompt(anthropicRequest.system);

    return {
        model: anthropicRequest.model || context.defaultModel || 'gpt-5.2-codex',
        input: convertAnthropicMessagesToResponsesInput(anthropicRequest.messages || []),
        tools: convertAnthropicToolsToOpenAI(anthropicRequest.tools),
        tool_choice: anthropicRequest.tool_choice || 'auto',
        parallel_tool_calls: true,
        store: false,
        stream: context.stream ?? anthropicRequest.stream ?? true,
        include: [],
        instructions: instructions || ''
    };
}

export default {
    SOURCE_PROTOCOL,
    TARGET_PROTOCOL,
    translateAnthropicToOpenAIResponsesRequest
};
