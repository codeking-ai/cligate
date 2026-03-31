import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeJsonSchema } from '../../src/json-schema-normalizer.js';

test('normalizeJsonSchema flattens nested defs and refs', () => {
  const schema = {
    type: 'object',
    properties: {
      config: {
        $defs: {
          Address: {
            type: 'object',
            properties: {
              city: { type: 'string' }
            },
            required: ['city']
          }
        },
        properties: {
          home: { $ref: '#/$defs/Address' }
        }
      }
    }
  };

  const normalized = normalizeJsonSchema(schema);
  assert.equal(normalized.properties.config.type, 'object');
  assert.equal(normalized.properties.config.properties.home.type, 'object');
  assert.equal(normalized.properties.config.properties.home.properties.city.type, 'string');
  assert.deepEqual(normalized.properties.config.properties.home.required, ['city']);
});

test('normalizeJsonSchema merges allOf and converts const into enum', () => {
  const schema = {
    allOf: [
      {
        properties: {
          mode: { const: 'raw' }
        },
        required: ['mode']
      },
      {
        properties: {
          enabled: { type: ['boolean', 'null'] }
        }
      }
    ]
  };

  const normalized = normalizeJsonSchema(schema);
  assert.equal(normalized.type, 'object');
  assert.deepEqual(normalized.properties.mode.enum, ['raw']);
  assert.equal(normalized.properties.mode.type, 'string');
  assert.equal(normalized.properties.enabled.type, 'boolean');
  assert.match(normalized.properties.enabled.description, /nullable/);
  assert.deepEqual(normalized.required, ['mode']);
});

test('normalizeJsonSchema converts standalone const nodes into enum', () => {
  const schema = {
    type: 'object',
    properties: {
      mode: { const: 'raw' }
    }
  };

  const normalized = normalizeJsonSchema(schema);
  assert.deepEqual(normalized.properties.mode.enum, ['raw']);
  assert.equal(normalized.properties.mode.type, 'string');
});

test('normalizeJsonSchema picks best anyOf branch and keeps type hint', () => {
  const schema = {
    anyOf: [
      { type: 'string' },
      {
        type: 'object',
        properties: {
          foo: { type: 'string', minLength: 1 }
        }
      }
    ]
  };

  const normalized = normalizeJsonSchema(schema);
  assert.equal(normalized.type, 'object');
  assert.equal(normalized.properties.foo.type, 'string');
  assert.match(normalized.description, /Accepts:/);
  assert.match(normalized.properties.foo.description, /Constraint:/);
});

test('normalizeJsonSchema heals object-like nodes that misuse items', () => {
  const schema = {
    type: 'object',
    items: {
      color: { type: 'string' },
      size: { type: 'number' }
    }
  };

  const normalized = normalizeJsonSchema(schema);
  assert.equal(normalized.type, 'object');
  assert.equal(normalized.properties.color.type, 'string');
  assert.equal(normalized.properties.size.type, 'number');
});
