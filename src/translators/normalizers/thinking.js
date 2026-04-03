import {
    cleanCacheControl,
    processAssistantContent,
    hasUnsignedThinkingBlocks,
    removeTrailingThinkingBlocks,
    restoreThinkingSignatures,
    reorderAssistantContent
} from '../../thinking-utils.js';
import {
    getCachedSignature,
    cacheSignature,
    cacheThinkingSignature,
    SIGNATURE_CONSTANTS
} from '../../signature-cache.js';

export function processAnthropicAssistantContent(content) {
    return processAssistantContent(content);
}

export function cacheToolUseSignature(toolUseId, signature) {
    if (signature && signature.length >= SIGNATURE_CONSTANTS.MIN_SIGNATURE_LENGTH) {
        cacheSignature(toolUseId, signature);
    }
}

export function restoreToolUseSignature(toolUseId) {
    return getCachedSignature(toolUseId);
}

export function cacheReasoningSignature(signature, family = 'openai') {
    if (signature && signature.length >= SIGNATURE_CONSTANTS.MIN_SIGNATURE_LENGTH) {
        cacheThinkingSignature(signature, family);
    }
}

export {
    cleanCacheControl,
    hasUnsignedThinkingBlocks,
    removeTrailingThinkingBlocks,
    restoreThinkingSignatures,
    reorderAssistantContent,
    SIGNATURE_CONSTANTS
};

export default {
    cleanCacheControl,
    processAnthropicAssistantContent,
    hasUnsignedThinkingBlocks,
    removeTrailingThinkingBlocks,
    restoreThinkingSignatures,
    reorderAssistantContent,
    cacheToolUseSignature,
    restoreToolUseSignature,
    cacheReasoningSignature,
    SIGNATURE_CONSTANTS
};
