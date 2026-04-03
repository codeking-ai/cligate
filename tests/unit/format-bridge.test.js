import test from 'node:test';
import assert from 'node:assert/strict';

import { anthropicToOpenAI } from '../../src/providers/format-bridge.js';

test('format-bridge anthropicToOpenAI converts function tools via shared normalizer', () => {
  const result = anthropicToOpenAI({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      name: 'search_repo',
      description: 'Search repository',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 }
        },
        additionalProperties: false
      }
    }],
    tool_choice: { type: 'tool', name: 'search_repo' }
  });

  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].type, 'function');
  assert.equal(result.tools[0].function.name, 'search_repo');
  assert.equal(result.tools[0].function.parameters.properties.query.type, 'string');
  assert.equal('minLength' in result.tools[0].function.parameters.properties.query, false);
  assert.deepEqual(result.tool_choice, { type: 'function', function: { name: 'search_repo' } });
});

test('format-bridge anthropicToOpenAI omits hosted tools from chat request', () => {
  const result = anthropicToOpenAI({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'search the web' }],
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 3
    }],
    tool_choice: { type: 'tool', name: 'web_search' }
  });

  assert.equal(result.tools, undefined);
  assert.equal(result.tool_choice, 'auto');
});
