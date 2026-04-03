export function normalizeOpenAIResponsesUsage(usage) {
    return {
        input_tokens: usage?.input_tokens || 0,
        output_tokens: usage?.output_tokens || 0,
        cache_read_input_tokens: usage?.cache_read_input_tokens || 0,
        cache_creation_input_tokens: usage?.cache_creation_input_tokens || 0
    };
}

export default {
    normalizeOpenAIResponsesUsage
};
