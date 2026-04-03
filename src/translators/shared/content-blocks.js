import { toAnthropicToolId } from '../normalizers/tool-ids.js';
import { cacheReasoningSignature, cacheToolUseSignature, SIGNATURE_CONSTANTS } from '../normalizers/thinking.js';

const { MIN_SIGNATURE_LENGTH } = SIGNATURE_CONSTANTS;

export function convertResponsesOutputToAnthropicContent(output) {
    if (!Array.isArray(output)) {
        return [{ type: 'text', text: '' }];
    }

    const content = [];

    for (const item of output) {
        if (item?.type === 'message') {
            for (const part of item.content || []) {
                if (part?.type === 'output_text') {
                    content.push({ type: 'text', text: part.text });
                }
            }
            continue;
        }

        if (item?.type === 'function_call') {
            let input = {};

            try {
                input = typeof item.arguments === 'string'
                    ? JSON.parse(item.arguments)
                    : item.arguments || {};
            } catch {
                input = {};
            }

            const toolId = toAnthropicToolId(item.call_id || item.id);
            const toolUseBlock = {
                type: 'tool_use',
                id: toolId,
                name: item.name,
                input
            };

            if (item.signature && item.signature.length >= MIN_SIGNATURE_LENGTH) {
                toolUseBlock.thoughtSignature = item.signature;
                cacheToolUseSignature(toolId, item.signature);
            }

            content.push(toolUseBlock);
            continue;
        }

        if (item?.type === 'reasoning') {
            const signature = item.signature || '';
            if (signature && signature.length >= MIN_SIGNATURE_LENGTH) {
                cacheReasoningSignature(signature, 'openai');
            }

            content.push({
                type: 'thinking',
                thinking: item.text || item.content || '',
                signature
            });
        }
    }

    return content.length > 0 ? content : [{ type: 'text', text: '' }];
}

export default {
    convertResponsesOutputToAnthropicContent
};
