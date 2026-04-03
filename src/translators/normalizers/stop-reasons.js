export function inferAnthropicStopReasonFromResponsesOutput(output) {
    if (!Array.isArray(output)) {
        return 'end_turn';
    }

    return output.some(item => item?.type === 'function_call')
        ? 'tool_use'
        : 'end_turn';
}

export default {
    inferAnthropicStopReasonFromResponsesOutput
};
