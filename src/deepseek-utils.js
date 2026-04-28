const LEGACY_DEEPSEEK_MODEL_ALIASES = Object.freeze({
    'deepseek-chat': {
        model: 'deepseek-v4-flash',
        thinkingType: 'disabled'
    },
    'deepseek-reasoner': {
        model: 'deepseek-v4-flash',
        thinkingType: 'enabled'
    }
});

const DEEPSEEK_MODEL_IDS = new Set([
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    ...Object.keys(LEGACY_DEEPSEEK_MODEL_ALIASES)
]);

export function isDeepSeekProviderType(providerType) {
    return String(providerType || '').trim().toLowerCase() === 'deepseek';
}

export function isDeepSeekModel(model) {
    const normalized = String(model || '').trim().toLowerCase();
    return DEEPSEEK_MODEL_IDS.has(normalized);
}

export function normalizeDeepSeekRequestBody(body) {
    if (!body || typeof body !== 'object') return body;

    let normalized = body;

    const alias = LEGACY_DEEPSEEK_MODEL_ALIASES[String(body.model || '').trim().toLowerCase()];
    if (alias) {
        normalized = { ...body, model: alias.model };
        if (!normalized.thinking || typeof normalized.thinking !== 'object') {
            normalized.thinking = { type: alias.thinkingType };
        }
    }

    // DeepSeek defaults `thinking` to enabled. With thinking enabled, any prior
    // assistant turn that produced tool_calls must echo its `reasoning_content`
    // back on the next request, or the API returns:
    //   400 — "The `reasoning_content` in the thinking mode must be passed
    //   back to the API."
    // Codex / OpenAI Responses clients do not preserve the proxy-emitted
    // `type:'reasoning'` items across turns (they lack `encrypted_content`),
    // so multi-turn tool conversations cannot satisfy that requirement on the
    // OpenAI-protocol path. Default to disabled when the caller did not set
    // `thinking` explicitly; callers that want thinking can opt in.
    if (!normalized.thinking || typeof normalized.thinking !== 'object') {
        normalized = { ...normalized, thinking: { type: 'disabled' } };
    }

    return normalized;
}

export function extractDeepSeekReasoningText(item) {
    if (item?.type !== 'reasoning') return '';

    if (typeof item.text === 'string' && item.text.trim()) {
        return item.text.trim();
    }

    if (Array.isArray(item.summary)) {
        return item.summary
            .map((part) => {
                if (typeof part === 'string') return part;
                if (typeof part?.text === 'string') return part.text;
                if (typeof part?.content === 'string') return part.content;
                return '';
            })
            .map((text) => text.trim())
            .filter(Boolean)
            .join('\n');
    }

    return '';
}

export function mergeDeepSeekReasoningText(existing, incoming) {
    const left = String(existing || '').trim();
    const right = String(incoming || '').trim();

    if (!left) return right;
    if (!right) return left;
    return `${left}\n${right}`;
}

export default {
    extractDeepSeekReasoningText,
    isDeepSeekModel,
    isDeepSeekProviderType,
    mergeDeepSeekReasoningText,
    normalizeDeepSeekRequestBody
};
