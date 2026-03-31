import test from 'node:test';
import assert from 'node:assert/strict';

import { _testExports } from '../../src/antigravity-api.js';

const { mapAntigravityUpstreamModel, buildGeminiRequest } = _testExports;

test('mapAntigravityUpstreamModel remaps Claude models to Antigravity-compatible upstream ids', () => {
  assert.equal(mapAntigravityUpstreamModel('antigravity/claude-opus-4-6'), 'claude-opus-4-6-thinking');
  assert.equal(mapAntigravityUpstreamModel('claude-opus-4-5-20251101'), 'claude-opus-4-6-thinking');
  assert.equal(mapAntigravityUpstreamModel('claude-haiku-4-5-20251001'), 'claude-sonnet-4-6');
  assert.equal(mapAntigravityUpstreamModel('antigravity/gemini-2.5-pro'), 'gemini-2.5-pro');
});

test('buildGeminiRequest wraps Anthropic messages into v1internal request envelope with cleaned tools', () => {
  const request = buildGeminiRequest({
    model: 'antigravity/claude-opus-4-6',
    system: 'You are a coding assistant.',
    messages: [
      { role: 'user', content: 'hello' }
    ],
    tools: [
      {
        name: 'apply_patch',
        description: 'Apply patch',
        input_schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          additionalProperties: false,
          propertyNames: { pattern: '^[a-z]+$' },
          properties: {
            content: {
              type: 'string',
              format: 'patch',
              exclusiveMinimum: 1
            },
            mode: {
              anyOf: [
                { type: 'string' },
                { const: 'raw' }
              ]
            },
            config: {
              allOf: [
                {
                  type: 'object',
                  properties: {
                    enabled: { const: true }
                  },
                  required: ['enabled']
                },
                {
                  properties: {
                    target: { $ref: '#/$defs/Target' }
                  }
                }
              ]
            }
          },
          required: ['content']
        }
      }
    ],
    max_tokens: 4096
  }, 'test-project', 'antigravity/claude-opus-4-6');

  assert.equal(request.project, 'test-project');
  assert.equal(request.model, 'claude-opus-4-6-thinking');
  assert.equal(request.requestType, 'agent');
  assert.ok(Array.isArray(request.request.contents));
  assert.equal(request.request.contents[0].role, 'user');
  assert.equal(request.request.systemInstruction.parts[0].text, 'You are a coding assistant.');
  assert.equal(request.request.generationConfig.maxOutputTokens, 4096);
  assert.equal(request.request.toolConfig.functionCallingConfig.mode, 'VALIDATED');
  assert.equal(request.request.tools[0].functionDeclarations[0].name, 'apply_patch');
  assert.equal(request.request.tools[0].functionDeclarations[0].parameters.$schema, undefined);
  assert.equal(request.request.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined);
  assert.equal(request.request.tools[0].functionDeclarations[0].parameters.propertyNames, undefined);
  assert.equal(request.request.tools[0].functionDeclarations[0].parameters.properties.content.format, undefined);
  assert.equal(request.request.tools[0].functionDeclarations[0].parameters.properties.content.exclusiveMinimum, undefined);
  assert.equal(request.request.tools[0].functionDeclarations[0].parameters.properties.mode.type, 'string');
  assert.equal(request.request.tools[0].functionDeclarations[0].parameters.properties.mode.anyOf, undefined);
  assert.equal(request.request.tools[0].functionDeclarations[0].parameters.properties.config.properties.enabled.const, undefined);
  assert.deepEqual(request.request.tools[0].functionDeclarations[0].parameters.properties.config.properties.enabled.enum, ['true']);
  assert.equal(request.request.tools[0].functionDeclarations[0].parameters.properties.config.properties.target.type, 'string');
});
