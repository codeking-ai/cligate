export async function runAssistantToolLoop({
  executor,
  calls = [],
  context = {},
  maxIterations = 20,
  stopOnError = false
} = {}) {
  if (!executor?.executeToolCall) {
    throw new Error('executor with executeToolCall() is required');
  }

  const results = [];
  const limit = Math.max(1, Number(maxIterations) || 20);
  for (let index = 0; index < calls.length && index < limit; index += 1) {
    const result = await executor.executeToolCall(calls[index], context);
    results.push({
      invocation: calls[index],
      result
    });
    if (stopOnError && ['failed', 'denied', 'requires_approval'].includes(result.status)) {
      break;
    }
  }

  return {
    iterations: results.length,
    exhausted: calls.length > limit,
    results
  };
}

export default runAssistantToolLoop;
