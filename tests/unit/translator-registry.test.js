import test from 'node:test';
import assert from 'node:assert/strict';

import { translateRequest, translateResponse } from '../../src/translators/registry.js';

test('registry translates anthropic messages request into openai responses request', () => {
  const result = translateRequest('anthropic-messages', 'openai-responses', {
    model: 'gpt-5.2',
    system: [{ type: 'text', text: 'Be concise.' }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          {
            type: 'image',
            source: {
              type: 'url',
              url: 'https://example.com/cat.jpg',
              media_type: 'image/jpeg'
            }
          }
        ]
      }
    ]
  }, { stream: false });

  assert.equal(result.model, 'gpt-5.2');
  assert.equal(result.stream, false);
  assert.equal(result.instructions, 'Be concise.');
  assert.ok(Array.isArray(result.input[0].content));
  assert.equal(result.input[0].content[0].type, 'input_text');
  assert.equal(result.input[0].content[1].type, 'input_image');
});

test('registry translates openai responses payload into anthropic message', () => {
  const result = translateResponse('openai-responses', 'anthropic-messages', {
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
      { type: 'function_call', call_id: 'fc_123', name: 'search', arguments: '{"q":"repo"}' }
    ],
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3 }
  }, { model: 'claude-sonnet-4' });

  assert.equal(result.type, 'message');
  assert.equal(result.model, 'claude-sonnet-4');
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[1].type, 'tool_use');
  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 20);
  assert.equal(result.usage.cache_read_input_tokens, 3);
});
