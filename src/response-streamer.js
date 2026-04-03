/**
 * Legacy compatibility wrapper for the Phase 1 translator kernel.
 */

import {
    streamOpenAIResponsesAsAnthropicEvents as streamResponsesAPI,
    parseOpenAIResponsesSSE as parseResponsesAPIResponse
} from './translators/response/openai-responses-sse-to-anthropic-sse.js';
import { formatSSEEvent } from './translators/shared/sse.js';

export {
    streamResponsesAPI,
    parseResponsesAPIResponse,
    formatSSEEvent
};

export default {
    streamResponsesAPI,
    parseResponsesAPIResponse,
    formatSSEEvent
};
