import { toOpenAIToolId } from './tool-ids.js';

export function convertAnthropicBlockToResponsesInput(block) {
    if (!block || typeof block !== 'object') return null;

    if (block.type === 'text') {
        return { type: 'input_text', text: block.text || '' };
    }

    if (block.type === 'image') {
        if (block.source?.type === 'base64' && block.source.data) {
            return {
                type: 'input_image',
                data: block.source.data,
                media_type: block.source.media_type || 'image/jpeg'
            };
        }

        if (block.source?.type === 'url' && block.source.url) {
            return {
                type: 'input_image',
                image_url: block.source.url,
                media_type: block.source.media_type || 'image/jpeg'
            };
        }
    }

    return null;
}

export function normalizeAnthropicToolResultOutput(block) {
    if (typeof block?.content === 'string') {
        return block.content;
    }

    if (Array.isArray(block?.content)) {
        const richContent = block.content
            .map(convertAnthropicBlockToResponsesInput)
            .filter(Boolean);

        if (richContent.length > 0) {
            return richContent;
        }

        return block.content
            .filter(item => item?.type === 'text')
            .map(item => item.text)
            .join('\n');
    }

    if (block?.content !== undefined) {
        return JSON.stringify(block.content);
    }

    return '';
}

export function convertAnthropicUserContent(content) {
    const textParts = [];
    const toolResults = [];
    const imageParts = [];

    if (typeof content === 'string') {
        textParts.push(content);
        return { textParts, toolResults, imageParts };
    }

    if (!Array.isArray(content)) {
        return { textParts, toolResults, imageParts };
    }

    for (const block of content) {
        if (block?.type === 'text') {
            textParts.push(block.text);
            continue;
        }

        if (block?.type === 'image') {
            const imageInput = convertAnthropicBlockToResponsesInput(block);
            if (imageInput) imageParts.push(imageInput);
            continue;
        }

        if (block?.type === 'tool_result') {
            const output = normalizeAnthropicToolResultOutput(block);
            toolResults.push({
                type: 'function_call_output',
                call_id: toOpenAIToolId(block.tool_use_id),
                output: (block.is_error && typeof output === 'string')
                    ? `Error: ${output}`
                    : output
            });
        }
    }

    return { textParts, toolResults, imageParts };
}

export default {
    convertAnthropicBlockToResponsesInput,
    normalizeAnthropicToolResultOutput,
    convertAnthropicUserContent
};
