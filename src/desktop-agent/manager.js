import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getDesktopAgentSettings } from './settings.js';
import { ensureDesktopAgentToken } from './token-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT = join(__dirname, 'runtime', 'desktop-agent-server.py');

function resolveRuntimeScript() {
  const unpackedCandidate = DEFAULT_SCRIPT.includes('app.asar')
    ? DEFAULT_SCRIPT.replace('app.asar', 'app.asar.unpacked')
    : DEFAULT_SCRIPT;
  if (existsSync(unpackedCandidate)) {
    return unpackedCandidate;
  }
  return DEFAULT_SCRIPT;
}

function parsePort(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return parsed.port ? Number(parsed.port) : 8765;
  } catch {
    return 8765;
  }
}

const STDERR_RING_LIMIT = 4096;

function ringAppend(prev, chunk) {
  const next = (prev || '') + String(chunk || '');
  return next.length > STDERR_RING_LIMIT
    ? next.slice(next.length - STDERR_RING_LIMIT)
    : next;
}

export class DesktopAgentManager {
  constructor({
    getSettings = getDesktopAgentSettings,
    ensureToken = ensureDesktopAgentToken,
    spawnImpl = spawn
  } = {}) {
    this.getSettings = getSettings;
    this.ensureToken = ensureToken;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.startedAt = null;
    this.lastError = '';
    this.recentStderr = '';
    this.recentStdout = '';
  }

  getStatus() {
    return {
      running: !!this.child && this.child.exitCode === null,
      pid: this.child?.pid || null,
      startedAt: this.startedAt,
      lastError: this.lastError,
      recentStderr: this.recentStderr,
      recentStdout: this.recentStdout
    };
  }

  async start() {
    if (this.getStatus().running) {
      return this.getStatus();
    }
    const settings = this.getSettings();
    const token = this.ensureToken();
    const command = String(settings.command || '').trim() || 'python';
    const args = Array.isArray(settings.args) && settings.args.length > 0
      ? [...settings.args]
      : [resolveRuntimeScript(), '--port', String(parsePort(settings.baseUrl)), '--token', token];
    this.child = this.spawnImpl(command, args, {
      stdio: 'pipe',
      windowsHide: true
    });
    this.startedAt = new Date().toISOString();
    this.lastError = '';
    this.recentStderr = '';
    this.recentStdout = '';
    // Drain both pipes — if we leave them unread the Python child will block on
    // a full OS pipe buffer (typically 64 KB), and our /api/desktop-agent/status
    // would have no clue why a runtime endpoint is hanging or what import the
    // server choked on. Keeping the tail in memory lets the dashboard and the
    // assistant LLM both surface the real Python exception.
    if (this.child.stderr) {
      this.child.stderr.on('data', (chunk) => {
        this.recentStderr = ringAppend(this.recentStderr, chunk);
      });
    }
    if (this.child.stdout) {
      this.child.stdout.on('data', (chunk) => {
        this.recentStdout = ringAppend(this.recentStdout, chunk);
      });
    }
    this.child.on('exit', (code, signal) => {
      // Prefer a Python traceback over the raw exit code — if the child died at
      // import time the last few KB of stderr is the only useful evidence.
      const tail = String(this.recentStderr || '').trim().split('\n').slice(-3).join(' | ').slice(-400);
      if (code && code !== 0) {
        this.lastError = tail
          ? `desktop_agent_exit_${code}: ${tail}`
          : `desktop_agent_exit_${code}`;
      } else if (signal) {
        this.lastError = tail
          ? `desktop_agent_signal_${signal}: ${tail}`
          : `desktop_agent_signal_${signal}`;
      }
      this.child = null;
    });
    this.child.on('error', (error) => {
      this.lastError = String(error?.message || error || 'desktop_agent_spawn_failed');
    });
    return this.getStatus();
  }

  stop() {
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
    }
    this.child = null;
    return this.getStatus();
  }
}

const desktopAgentManager = new DesktopAgentManager();

export { DEFAULT_SCRIPT, resolveRuntimeScript, desktopAgentManager };
export default desktopAgentManager;
