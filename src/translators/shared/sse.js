export function formatSSEEvent(event) {
    return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function buildAnthropicMessageStart({ messageId, model }) {
    return {
        event: 'message_start',
        data: {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        }
    };
}

export function buildContentBlockStart({ index, contentBlock }) {
    return {
        event: 'content_block_start',
        data: {
            type: 'content_block_start',
            index,
            content_block: contentBlock
        }
    };
}

export function buildContentBlockDelta({ index, delta }) {
    return {
        event: 'content_block_delta',
        data: {
            type: 'content_block_delta',
            index,
            delta
        }
    };
}

export function buildContentBlockStop({ index }) {
    return {
        event: 'content_block_stop',
        data: {
            type: 'content_block_stop',
            index
        }
    };
}

export function buildMessageDelta({ stopReason, usage }) {
    return {
        event: 'message_delta',
        data: {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage
        }
    };
}

export function buildMessageStop() {
    return {
        event: 'message_stop',
        data: { type: 'message_stop' }
    };
}

export default {
    formatSSEEvent,
    buildAnthropicMessageStart,
    buildContentBlockStart,
    buildContentBlockDelta,
    buildContentBlockStop,
    buildMessageDelta,
    buildMessageStop
};
