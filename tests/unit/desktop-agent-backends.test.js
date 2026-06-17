import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveDesktopBackend,
  selectDesktopBackend,
  pythonHttpBackend,
  macosNativeBackend
} from '../../src/desktop-agent/backends/index.js';

// These tests pin the decoupled backend-selection layer. The overriding goal is
// that adding the macOS native backend NEVER changes how the Windows/Linux
// Python agent gets launched. Platform is injected explicitly so the whole
// matrix is verifiable from a Windows dev box.

test('selectDesktopBackend picks python-http for win32/linux and macos-native only for darwin', () => {
  assert.equal(selectDesktopBackend('win32').id, 'python-http');
  assert.equal(selectDesktopBackend('linux').id, 'python-http');
  assert.equal(selectDesktopBackend('freebsd').id, 'python-http');
  assert.equal(selectDesktopBackend('darwin').id, 'macos-native');
});

test('win32 fresh install (command:"" args:[]) reproduces the historical python launch', () => {
  const { id, command, args, port } = resolveDesktopBackend({
    platform: 'win32',
    settings: { baseUrl: 'http://127.0.0.1:8765', command: '', args: [] },
    token: 'tok-123'
  });

  assert.equal(id, 'python-http');
  assert.equal(command, 'python');
  assert.equal(port, 8765);
  // args: [<script>.py, '--port', '8765', '--token', 'tok-123']
  assert.match(args[0], /desktop-agent-server\.py$/);
  assert.deepEqual(args.slice(1), ['--port', '8765', '--token', 'tok-123']);
});

test('win32 honours an explicit command/args override (escape hatch unchanged)', () => {
  const { command, args } = resolveDesktopBackend({
    platform: 'win32',
    settings: {
      baseUrl: 'http://127.0.0.1:8899',
      command: 'py',
      args: ['custom-agent.py', '--port', '8899']
    },
    token: 'ignored-when-args-overridden'
  });

  assert.equal(command, 'py');
  assert.deepEqual(args, ['custom-agent.py', '--port', '8899']);
});

test('darwin fresh install selects the native helper binary with --port/--token', () => {
  const { id, command, args, port } = resolveDesktopBackend({
    platform: 'darwin',
    settings: { baseUrl: 'http://127.0.0.1:8765', command: '', args: [] },
    token: 'tok-abc'
  });

  assert.equal(id, 'macos-native');
  // The binary path is resolved from disk; only its basename is contractually
  // stable across dev/packaged/asar layouts.
  assert.match(command, /cligate-desktop-agent$/);
  assert.equal(port, 8765);
  assert.deepEqual(args, ['--port', '8765', '--token', 'tok-abc']);
});

test('darwin honours an explicit command override (e.g. a locally-built binary)', () => {
  const { command, args } = resolveDesktopBackend({
    platform: 'darwin',
    settings: {
      baseUrl: 'http://127.0.0.1:8765',
      command: '/Users/me/cligate-desktop-agent',
      args: []
    },
    token: 'tok-xyz'
  });

  assert.equal(command, '/Users/me/cligate-desktop-agent');
  // args still fall through to the macOS defaults when not overridden.
  assert.deepEqual(args, ['--port', '8765', '--token', 'tok-xyz']);
});

test('port is parsed from baseUrl and falls back to 8765 on a malformed url', () => {
  assert.equal(
    resolveDesktopBackend({ platform: 'win32', settings: { baseUrl: 'http://127.0.0.1:9001' } }).port,
    9001
  );
  assert.equal(
    resolveDesktopBackend({ platform: 'darwin', settings: { baseUrl: 'not-a-url' } }).port,
    8765
  );
});

test('both backends expose a stable id and a defaultLaunch contract', () => {
  assert.equal(pythonHttpBackend.id, 'python-http');
  assert.equal(macosNativeBackend.id, 'macos-native');
  assert.equal(typeof pythonHttpBackend.defaultLaunch, 'function');
  assert.equal(typeof macosNativeBackend.defaultLaunch, 'function');
});
