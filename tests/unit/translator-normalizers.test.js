import test from 'node:test';
import assert from 'node:assert/strict';

import { convertAnthropicUserContent } from '../../src/translators/normalizers/multimodal.js';
import { sanitizeToolSchema } from '../../src/translators/normalizers/schemas.js';
import { toOpenAIToolId, toAnthropicToolId } from '../../src/translators/normalizers/tool-ids.js';
import { normalizeOpenAIResponsesUsage } from '../../src/translators/normalizers/usage.js';
import { inferAnthropicStopReasonFromResponsesOutput } from '../../src/translators/normalizers/stop-reasons.js';

test('tool id normalizer maps between anthropic and openai ids deterministically', () => {
  assert.equal(toOpenAIToolId('toolu_abc'), 'fc_abc');
  assert.equal(toOpenAIToolId('call_abc'), 'fc_abc');
  assert.equal(toAnthropicToolId('fc_abc'), 'toolu_abc');
});

test('multimodal normalizer preserves rich tool_result image content', () => {
  const result = convertAnthropicUserContent([
    {
      type: 'tool_result',
      tool_use_id: 'toolu_img',
      content: [
        { type: 'text', text: 'image attached' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'abc123'
          }
        }
      ]
    }
  ]);

  assert.equal(result.toolResults.length, 1);
  assert.ok(Array.isArray(result.toolResults[0].output));
  assert.equal(result.toolResults[0].output[0].type, 'input_text');
  assert.equal(result.toolResults[0].output[1].type, 'input_image');
});

test('schema normalizer flattens top-level unions into provider-safe object schema', () => {
  const schema = sanitizeToolSchema({
    oneOf: [
      {
        type: 'object',
        properties: {
          selector: { type: 'string', minLength: 1 }
        },
        required: ['selector']
      },
      {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' }
        },
        required: ['x', 'y']
      }
    ]
  });

  assert.equal(schema.type, 'object');
  assert.equal(schema.oneOf, undefined);
  assert.ok(schema.properties.selector || schema.properties.x);
});

test('usage and stop-reason normalizers preserve openai responses semantics', () => {
  const usage = normalizeOpenAIResponsesUsage({
    input_tokens: 5,
    output_tokens: 7,
    cache_read_input_tokens: 2
  });

  assert.deepEqual(usage, {
    input_tokens: 5,
    output_tokens: 7,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 0
  });

  assert.equal(inferAnthropicStopReasonFromResponsesOutput([
    { type: 'message', content: [] },
    { type: 'function_call', call_id: 'fc_1', name: 'tool', arguments: '{}' }
  ]), 'tool_use');
});
