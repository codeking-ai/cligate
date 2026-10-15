import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The mapping page's provider normalization lives inline in the settings-page
// module (browser code). Extract the switch from source so these tests pin the
// real implementation, not a copy.
const settingsPageSource = readFileSync(
  join(fileURLToPath(import.meta.url), '..', '..', '..', 'public', 'js', 'modules', 'settings-page.js'),
  'utf8'
);
const match = settingsPageSource.match(/normalizeModelMappingProvider\(type\) \{[\s\S]*?\n    \},/);
if (!match) throw new Error('normalizeModelMappingProvider not found in settings-page.js');

function normalize(type) {
  // Evaluate the extracted switch body as a plain function of `type`.
  const body = match[0]
    .replace(/^normalizeModelMappingProvider\(type\) \{/, '')
    .replace(/\n    \},$/, '');
  return new Function('type', body)(type);
}

test('normalizeModelMappingProvider keeps provider identity 1:1 with runtime resolveModel', () => {
  // zhipu/moonshot/minimax now have their own tier maps (provider-presets.js);
  // folding them into 'openai' made the mapping page edit a map the runtime
  // never consulted for those keys.
  assert.equal(normalize('openai'), 'openai');
  assert.equal(normalize('zhipu'), 'zhipu');
  assert.equal(normalize('moonshot'), 'moonshot');
  assert.equal(normalize('minimax'), 'minimax');
});

test('normalizeModelMappingProvider preserves native mapping families', () => {
  assert.equal(normalize('anthropic'), 'anthropic');
  assert.equal(normalize('gemini'), 'gemini');
  assert.equal(normalize('vertex-ai'), 'vertex-ai');
  assert.equal(normalize('deepseek'), 'deepseek');
});

test('normalizeModelMappingProvider falls back to raw type, then null', () => {
  assert.equal(normalize('qwen'), 'qwen');
  assert.equal(normalize('openrouter'), 'openrouter');
  assert.equal(normalize('clinepass'), 'clinepass');
  assert.equal(normalize(''), null);
  assert.equal(normalize(undefined), null);
});
