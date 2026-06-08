import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  installTool,
  updateTool,
  checkLatestVersion,
  isNetworkRelatedFailure,
  __setToolInstallerExecutionAdapterForTests,
  __resetToolInstallerExecutionAdapterForTests,
  __clearToolInstallerVersionCacheForTests
} from '../../src/tool-installer.js';

function createMockChildProcess({ stdout = '', stderr = '', code = 0, error = null }) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {};

  queueMicrotask(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    if (error) {
      proc.emit('error', error);
      return;
    }
    proc.emit('close', code);
  });

  return proc;
}

test.afterEach(() => {
  __resetToolInstallerExecutionAdapterForTests();
  __clearToolInstallerVersionCacheForTests();
});

test('isNetworkRelatedFailure recognizes common npm network errors', () => {
  assert.equal(isNetworkRelatedFailure('npm ERR! code ECONNRESET'), true);
  assert.equal(isNetworkRelatedFailure('request failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org'), true);
  assert.equal(isNetworkRelatedFailure('npm ERR! 404 Not Found - GET https://registry.npmjs.org/foo'), false);
});

test('installTool stays on official npm registry when official install succeeds', async () => {
  const spawnCalls = [];

  __setToolInstallerExecutionAdapterForTests({
    runCommand(command) {
      if (command === 'npm --version') return '10.9.0';
      if (command === 'codex --version') return 'codex-cli 0.117.0';
      return null;
    },
    runCommandAsync(command) {
      if (command === 'npm --version') return Promise.resolve('10.9.0');
      if (command === 'codex --version') return Promise.resolve('codex-cli 0.117.0');
      return Promise.resolve(null);
    },
    spawnCommand(command, args, options) {
      spawnCalls.push({ command, args, options });
      return createMockChildProcess({ stdout: 'installed from official', code: 0 });
    }
  });

  const result = await installTool('codex');

  assert.equal(result.success, true);
  assert.equal(result.usedFallback, false);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(
    spawnCalls[0].args,
    ['install', '-g', '@openai/codex', '--registry', 'https://registry.npmjs.org/']
  );
  assert.equal(spawnCalls[0].options.env.npm_config_registry, 'https://registry.npmjs.org/');
});

test('installTool falls back only after official npm registry fails with network errors', async () => {
  const spawnCalls = [];
  let officialAttempts = 0;

  __setToolInstallerExecutionAdapterForTests({
    runCommand(command) {
      if (command === 'npm --version') return '10.9.0';
      if (command === 'codex --version') return 'codex-cli 0.117.0';
      return null;
    },
    runCommandAsync(command) {
      if (command === 'npm --version') return Promise.resolve('10.9.0');
      if (command === 'codex --version') return Promise.resolve('codex-cli 0.117.0');
      return Promise.resolve(null);
    },
    spawnCommand(command, args, options) {
      spawnCalls.push({ command, args, options });

      if (options.env.npm_config_registry === 'https://registry.npmjs.org/') {
        officialAttempts += 1;
        return createMockChildProcess({
          stderr: `npm ERR! code ECONNRESET\nattempt ${officialAttempts}`,
          code: 1
        });
      }

      return createMockChildProcess({
        stdout: 'installed from fallback registry',
        code: 0
      });
    }
  });

  const result = await installTool('codex');

  assert.equal(result.success, true);
  assert.equal(result.usedFallback, true);
  assert.equal(officialAttempts, 2);
  assert.equal(spawnCalls.length, 3);
  assert.equal(spawnCalls[2].options.env.npm_config_registry, 'https://registry.npmmirror.com/');
});

test('installTool does not fall back for non-network npm failures', async () => {
  const spawnCalls = [];

  __setToolInstallerExecutionAdapterForTests({
    runCommand(command) {
      if (command === 'npm --version') return '10.9.0';
      return null;
    },
    runCommandAsync(command) {
      if (command === 'npm --version') return Promise.resolve('10.9.0');
      return Promise.resolve(null);
    },
    spawnCommand(command, args, options) {
      spawnCalls.push({ command, args, options });
      return createMockChildProcess({
        stderr: 'npm ERR! 404 Not Found - GET https://registry.npmjs.org/@openai%2fcodex',
        code: 1
      });
    }
  });

  const result = await installTool('codex');

  assert.equal(result.success, false);
  assert.equal(result.usedFallback, false);
  assert.equal(result.fallbackTriggered, false);
  assert.equal(spawnCalls.length, 1);
  assert.match(result.error, /official source/i);
});

test('checkLatestVersion uses fallback registry only when official lookups fail', async () => {
  const calls = [];

  __setToolInstallerExecutionAdapterForTests({
    runCommand(command) {
      calls.push(command);
      if (command.includes('--registry=https://registry.npmjs.org/')) return null;
      if (command.includes('--registry=https://registry.npmmirror.com/')) return '0.200.0';
      return null;
    }
    ,
    runCommandAsync(command) {
      calls.push(command);
      if (command.includes('--registry=https://registry.npmjs.org/')) return Promise.resolve(null);
      if (command.includes('--registry=https://registry.npmmirror.com/')) return Promise.resolve('0.200.0');
      return Promise.resolve(null);
    }
  });

  const latest = await checkLatestVersion('codex');

  assert.equal(latest, '0.200.0');
  assert.equal(calls.length, 3);
  assert.match(calls[0], /registry\.npmjs\.org/);
  assert.match(calls[1], /registry\.npmjs\.org/);
  assert.match(calls[2], /registry\.npmmirror\.com/);
});

test('updateTool keeps package identity while using fallback transport when needed', async () => {
  const spawnCalls = [];

  __setToolInstallerExecutionAdapterForTests({
    runCommand(command) {
      if (command === 'npm --version') return '10.9.0';
      if (command === 'gemini --version') return '0.34.0';
      return null;
    },
    runCommandAsync(command) {
      if (command === 'npm --version') return Promise.resolve('10.9.0');
      if (command === 'gemini --version') return Promise.resolve('0.34.0');
      return Promise.resolve(null);
    },
    spawnCommand(command, args, options) {
      spawnCalls.push({ command, args, options });
      if (options.env.npm_config_registry === 'https://registry.npmjs.org/') {
        return createMockChildProcess({
          stderr: 'npm ERR! request to https://registry.npmjs.org failed, reason: ETIMEDOUT',
          code: 1
        });
      }
      return createMockChildProcess({
        stdout: 'updated from fallback registry',
        code: 0
      });
    }
  });

  const result = await updateTool('gemini');

  assert.equal(result.success, true);
  assert.equal(result.usedFallback, true);
  assert.equal(spawnCalls.length, 3);
  assert.deepEqual(
    spawnCalls[0].args,
    ['install', '-g', '@google/gemini-cli@latest', '--registry', 'https://registry.npmjs.org/']
  );
  assert.deepEqual(
    spawnCalls[spawnCalls.length - 1].args,
    ['install', '-g', '@google/gemini-cli@latest', '--registry', 'https://registry.npmmirror.com/']
  );
});
