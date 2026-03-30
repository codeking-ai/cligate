import test from 'node:test';
import assert from 'node:assert/strict';

import { _testExports } from '../../src/routes/responses-route.js';

test('normalizeCompactResponse keeps Responses API payload unchanged', () => {
  const payload = {
    object: 'response',
    model: 'gpt-5.4',
    status: 'completed',
    output: [],
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }
  };

  const result = _testExports.normalizeCompactResponse(JSON.stringify(payload), 'gpt-5.4');
  assert.deepEqual(result, payload);
});

test('normalizeCompactResponse converts chat completions payload to Responses format', () => {
  const payload = {
    id: 'chatcmpl_1',
    created: 123,
    choices: [
      {
        message: {
          content: 'hello'
        }
      }
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15
    }
  };

  const result = _testExports.normalizeCompactResponse(JSON.stringify(payload), 'gpt-5.4');
  assert.equal(result.object, 'response');
  assert.equal(result.model, 'gpt-5.4');
  assert.equal(result.output[0].type, 'message');
  assert.equal(result.output[0].content[0].text, 'hello');
});

test('normalizeCompactResponse returns null for invalid json', () => {
  const result = _testExports.normalizeCompactResponse('', 'gpt-5.4');
  assert.equal(result, null);
});
