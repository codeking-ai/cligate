import crypto from 'crypto';
import { cacheToolUseSignature, SIGNATURE_CONSTANTS } from '../normalizers/thinking.js';

const { MIN_SIGNATURE_LENGTH } = SIGNATURE_CONSTANTS;

function generateAnthropicMessageId() {
    return `msg_${crypto.randomBytes(16).toString('hex')}`;
}

function generateAnthropicToolId() {
    return `toolu_${crypto.randomBytes(12).toString('hex')}`;
}

function mapGeminiFinishReasonToAnthropic(finishReason, hasToolUse) {
    if (hasToolUse) return 'tool_use';

    switch ((finishReason || '').toUpperCase()) {
        case 'MAX_TOKENS':
            return 'max_tokens';
        case 'STOP':
        case 'FINISH_REASON_UNSPECIFIED':
        default:
            return 'end_turn';
    }
}

export function translateGeminiToAnthropicMessage(geminiResponse, originalModel) {
    const candidate = geminiResponse?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const usage = geminiResponse?.usageMetadata || {};
    const finishReason = candidate?.finishReason || geminiResponse?.finishReason;

    const content = [];
    for (const part of parts) {
        if (part?.text !== undefined && !part?.thought) {
            content.push({ type: 'text', text: part.text });
            continue;
        }

        if (part?.functionCall?.name) {
            const thoughtSignature = part.thoughtSignature || part.functionCall.thoughtSignature;
            const toolUseId = part.functionCall.id || generateAnthropicToolId();
            if (thoughtSignature && thoughtSignature.length >= MIN_SIGNATURE_LENGTH) {
                cacheToolUseSignature(toolUseId, thoughtSignature);
            }

            content.push({
                type: 'tool_use',
                id: toolUseId,
                name: part.functionCall.name,
                input: part.functionCall.args || {},
                ...(thoughtSignature && thoughtSignature.length >= MIN_SIGNATURE_LENGTH
                    ? { thoughtSignature }
                    : {})
            });
        }
    }

    if (content.length === 0) {
        content.push({ type: 'text', text: '' });
    }

    const hasToolUse = content.some(block => block.type === 'tool_use');

    return {
        id: generateAnthropicMessageId(),
        type: 'message',
        role: 'assistant',
        content,
        model: originalModel,
        stop_reason: mapGeminiFinishReasonToAnthropic(finishReason, hasToolUse),
        stop_sequence: null,
        usage: {
            input_tokens: usage.promptTokenCount || 0,
            output_tokens: usage.candidatesTokenCount || 0
        }
    };
}

export default {
    translateGeminiToAnthropicMessage
};
