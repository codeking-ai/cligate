import crypto from 'crypto';
import { convertResponsesOutputToAnthropicContent } from '../shared/content-blocks.js';
import { normalizeOpenAIResponsesUsage } from '../normalizers/usage.js';
import { inferAnthropicStopReasonFromResponsesOutput } from '../normalizers/stop-reasons.js';

export const SOURCE_PROTOCOL = 'openai-responses';
export const TARGET_PROTOCOL = 'anthropic-messages';

export function generateMessageId() {
    return `msg_${crypto.randomBytes(16).toString('hex')}`;
}

export function translateOpenAIResponsesToAnthropicMessage(apiResponse, context = {}) {
    if (!apiResponse) {
        return {
            id: generateMessageId(),
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            model: context.model,
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: normalizeOpenAIResponsesUsage()
        };
    }

    return {
        id: generateMessageId(),
        type: 'message',
        role: 'assistant',
        content: convertResponsesOutputToAnthropicContent(apiResponse.output),
        model: context.model,
        stop_reason: inferAnthropicStopReasonFromResponsesOutput(apiResponse.output),
        stop_sequence: null,
        usage: normalizeOpenAIResponsesUsage(apiResponse.usage)
    };
}

export function convertOutputToAnthropic(output) {
    return convertResponsesOutputToAnthropicContent(output);
}

export default {
    SOURCE_PROTOCOL,
    TARGET_PROTOCOL,
    generateMessageId,
    convertOutputToAnthropic,
    translateOpenAIResponsesToAnthropicMessage
};
