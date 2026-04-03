import crypto from 'crypto';

function randomToolId(prefix) {
    return `${prefix}${crypto.randomBytes(12).toString('hex')}`;
}

export function toOpenAIToolId(anthropicId) {
    if (!anthropicId) return randomToolId('fc_');
    if (anthropicId.startsWith('fc_')) return anthropicId;

    const baseId = anthropicId.replace(/^(call_|toolu_)/, '');
    return `fc_${baseId}`;
}

export function toAnthropicToolId(openAIId) {
    if (!openAIId) return randomToolId('toolu_');
    if (openAIId.startsWith('toolu_')) return openAIId;

    const baseId = openAIId.replace(/^fc_/, '');
    return `toolu_${baseId}`;
}

export default {
    toOpenAIToolId,
    toAnthropicToolId
};
