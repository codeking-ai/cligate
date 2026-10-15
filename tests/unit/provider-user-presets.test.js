// User-defined provider presets (~/.cligate/provider-presets.json).
// The loader runs at module init, so these tests must run in their own
// process with a fresh CLIGATE_CONFIG_DIR — spawning a child node process
// per test keeps the cache-per-process semantics honest.
import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');

function runWithPresets(presets) {
  const configDir = join(globalThis.__cligateTestEnvRoot, `presets-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(configDir, { recursive: true });
  if (presets !== null) {
    writeFileSync(join(configDir, 'provider-presets.json'), JSON.stringify(presets));
  }
  const result = spawnSync(process.execPath, [
    '--input-type=module', '-e',
    "import { PROVIDER_PRESETS } from './src/providers/provider-presets.js';"
      + 'console.log(JSON.stringify(PROVIDER_PRESETS.map(p => p.id)));',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, CLIGATE_CONFIG_DIR: configDir },
  });
  if (result.status !== 0) {
    throw new Error(`child failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

test('user presets file merges built-in and user-defined providers', () => {
  const ids = runWithPresets([
    { id: 'clinepass', label: 'ClinePass', baseUrl: 'https://api.clinepass.example/v1' },
  ]);
  assert.ok(ids.includes('qwen'), 'built-ins survive');
  assert.ok(ids.includes('clinepass'), 'user preset merged');
});

test('absent user presets file changes nothing', () => {
  const ids = runWithPresets(null);
  assert.deepEqual(ids.filter((id) => !['qwen', 'openrouter', 'zhipu', 'moonshot', 'minimax', 'clinepass', 'ollama-cloud'].includes(id)), []);
});

test('user preset colliding with a built-in id is skipped, not merged', () => {
  const ids = runWithPresets([
    { id: 'zhipu', baseUrl: 'https://evil.example/v1' },
    { id: 'valid', baseUrl: 'https://ok.example/v1' },
  ]);
  assert.equal(ids.filter((id) => id === 'zhipu').length, 1, 'built-in zhipu wins exactly once');
  assert.ok(ids.includes('valid'));
});

test('invalid user presets are skipped individually with no collateral damage', () => {
  const ids = runWithPresets([
    { id: 'bad id', baseUrl: 'https://x/v1' },
    { id: 'nobaseurl' },
    { id: 'badformat', baseUrl: 'https://x/v1', apiFormat: 'graphql' },
    { id: 'badtier', baseUrl: 'https://x/v1', tiers: { flagship: 'm1', bogus: 'm2' } },
    { id: 'good', baseUrl: 'https://x/v1', tiers: { flagship: 'm1' } },
  ]);
  assert.ok(ids.includes('good'), 'valid entry still merged despite siblings failing');
  assert.ok(!ids.includes('bad id'));
  assert.ok(!ids.includes('nobaseurl'));
  assert.ok(!ids.includes('badformat'));
  assert.ok(!ids.includes('badtier'), 'unknown tier key rejects the preset');
});

test('duplicate user preset ids collapse to the first entry', () => {
  const ids = runWithPresets([
    { id: 'dupe', baseUrl: 'https://a/v1' },
    { id: 'dupe', baseUrl: 'https://b/v1' },
  ]);
  assert.equal(ids.filter((id) => id === 'dupe').length, 1);
});
