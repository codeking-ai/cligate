import test from 'node:test';
import assert from 'node:assert/strict';

import {
  streamOpenAIResponsesAsAnthropicEvents,
  parseOpenAIResponsesSSE
} from '../../src/translators/response/openai-responses-sse-to-anthropic-sse.js';

function createSseResponse(events) {
  const payload = events.map(event => `data: ${JSON.stringify(event)}\n`).join('') + '\n';
  return new Response(payload, {
    headers: {
      'Content-Type': 'text/event-stream'
    }
  });
}

test('openai responses sse translator emits anthropic tool-use stream', async () => {
  const response = createSseResponse([
    {
      type: 'response.output_item.added',
      item: { type: 'function_call', call_id: 'fc_tool1', name: 'shell_command' }
    },
    {
      type: 'response.function_call_arguments.delta',
      delta: '{"command":"Get-ChildItem"}'
    },
    {
      type: 'response.completed',
      response: {
        usage: { input_tokens: 1, output_tokens: 2 }
      }
    }
  ]);

  const events = [];
  for await (const event of streamOpenAIResponsesAsAnthropicEvents(response, 'gpt-5.4')) {
    events.push(event);
  }

  assert.equal(events[0].event, 'message_start');
  assert.equal(events[1].event, 'content_block_start');
  assert.equal(events[1].data.content_block.type, 'tool_use');
  assert.equal(events[2].event, 'content_block_delta');
  assert.equal(events[2].data.delta.type, 'input_json_delta');
  assert.equal(events.at(-2).event, 'message_delta');
  assert.equal(events.at(-2).data.delta.stop_reason, 'tool_use');
});

test('openai responses sse parser extracts completed response payload', async () => {
  const response = createSseResponse([
    {
      type: 'response.output_item.added',
      item: { type: 'message', id: 'msg_1' }
    },
    {
      type: 'response.completed',
      response: {
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'done' }] }
        ],
        usage: { input_tokens: 2, output_tokens: 4 }
      }
    }
  ]);

  const parsed = await parseOpenAIResponsesSSE(response);
  assert.equal(parsed.output[0].type, 'message');
  assert.equal(parsed.usage.output_tokens, 4);
});
