function summarizeUnsupportedTools(unsupportedTools = []) {
    if (!Array.isArray(unsupportedTools) || unsupportedTools.length === 0) {
        return '';
    }

    return unsupportedTools
        .map(tool => tool?.name || tool?.hostedType || tool?.kind || 'unknown')
        .filter(Boolean)
        .join(',');
}

export function readTranslatorMeta(source) {
    return source?.__translatorMeta || null;
}

export function buildTranslatorMetaHeaders(source) {
    const meta = readTranslatorMeta(source);
    if (!meta) {
        return {};
    }

    const headers = {};
    if (Array.isArray(meta.unsupportedTools) && meta.unsupportedTools.length > 0) {
        headers['x-proxypool-unsupported-tools'] = summarizeUnsupportedTools(meta.unsupportedTools);
    }
    if (meta.toolChoiceMeta?.reason) {
        headers['x-proxypool-tool-choice-downgrade'] = meta.toolChoiceMeta.reason;
    }

    return headers;
}

export function describeTranslatorMeta(source) {
    const meta = readTranslatorMeta(source);
    if (!meta) {
        return {
            unsupportedTools: [],
            unsupportedToolNames: '',
            toolChoiceReason: ''
        };
    }

    return {
        unsupportedTools: Array.isArray(meta.unsupportedTools) ? meta.unsupportedTools : [],
        unsupportedToolNames: summarizeUnsupportedTools(meta.unsupportedTools),
        toolChoiceReason: meta.toolChoiceMeta?.reason || ''
    };
}

export default {
    buildTranslatorMetaHeaders,
    describeTranslatorMeta,
    readTranslatorMeta
};
