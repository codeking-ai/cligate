/**
 * Legacy compatibility wrapper for the Phase 1 translator kernel.
 */

import { translateAnthropicToOpenAIResponsesRequest } from './translators/request/anthropic-to-openai-responses.js';
import {
    convertOutputToAnthropic,
    generateMessageId
} from './translators/response/openai-responses-to-anthropic.js';
import {
    toOpenAIToolId,
    toAnthropicToolId
} from './translators/normalizers/tool-ids.js';

export function convertAnthropicToResponsesAPI(anthropicRequest) {
    return translateAnthropicToOpenAIResponsesRequest(anthropicRequest);
}

export {
    convertOutputToAnthropic,
    generateMessageId,
    toOpenAIToolId,
    toAnthropicToolId
};

export default {
    convertAnthropicToResponsesAPI,
    convertOutputToAnthropic,
    generateMessageId,
    toOpenAIToolId,
    toAnthropicToolId
};
