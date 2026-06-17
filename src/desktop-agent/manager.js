import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { getDesktopAgentSettings } from './settings.js';
import { ensureDesktopAgentToken } from './token-store.js';
import { desktopControlDir } from './paths.js';
import { resolveDesktopBackend } from './backends/index.js';
// Re-exported for backward compatibility: these used to live here and are kept
// importable from manager.js even though the launch logic now lives in
// backends/. They resolve the Python runtime script (Windows/Linux default).
import { DEFAULT_SCRIPT, resolveRuntimeScript } from './backends/python-http.js';

const STDERR_RING_LIMIT = 4096;

function ringAppend(prev, chunk) {
  const next = (prev || '') + String(chunk || '');
  return next.length > STDERR_RING_LIMIT
    ? next.slice(next.length - STDERR_RING_LIMIT)
    : next;
}

function probeExternalAgent(baseUrl, timeoutMs = 800) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL('/health', baseUrl);
    } catch {
      resolve(null);
      return;
    }
    const req = httpRequest(
      {
        method: 'GET',
        hostname: parsed.hostname,
        port: parsed.port || 8765,
        path: parsed.pathname,
        timeout: timeoutMs
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 4096) body = body.slice(0, 4096);
        });
        res.on('end', () => {
          let parsedBody = null;
          try { parsedBody = JSON.parse(body); } catch { parsedBody = null; }
          resolve({ statusCode: res.statusCode || 0, body: parsedBody });
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
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
    this.external = false;
    // Which backend the current/last spawn used ('python-http' | 'macos-native'),
    // surfaced in status for diagnostics. Empty until the first start().
    this.backendId = '';
  }

  getStatus() {
    if (this.external) {
      return {
        running: true,
        pid: null,
        startedAt: this.startedAt,
        lastError: this.lastError,
        recentStderr: this.recentStderr,
        recentStdout: this.recentStdout,
        external: true,
        backend: this.backendId
      };
    }
    return {
      running: !!this.child && this.child.exitCode === null,
      pid: this.child?.pid || null,
      startedAt: this.startedAt,
      lastError: this.lastError,
      recentStderr: this.recentStderr,
      recentStdout: this.recentStdout,
      external: false,
      backend: this.backendId
    };
  }

  async start() {
    if (this.getStatus().running) {
      return this.getStatus();
    }
    const settings = this.getSettings();
    const token = this.ensureToken();
    // Decoupled per-platform launch: Windows/Linux keep the Python HTTP agent,
    // macOS uses our native helper. Command/args precedence (explicit settings
    // override > per-platform default) is unchanged from the original logic.
    // Resolve it up front and record the backend id BEFORE the external-agent
    // probe, so status reports the platform backend even when we reuse an
    // already-running agent (and so it never depends on whether the probe finds
    // a live listener).
    const { command, args, id } = resolveDesktopBackend({ settings, token });
    this.backendId = id;
    // An *external* agent (typically the elevated scheduled task installed via
    // scripts/desktop-agent/install-elevated-task.ps1) may already own the port.
    // Spawning a second one would EADDRINUSE and silently leave the dashboard
    // pointing at the right port anyway, so detect this case and treat it as
    // "running, just not by us". This also means CliGate restarts no longer
    // tear down an elevated agent that's actively driving an installer.
    const existing = await probeExternalAgent(String(settings.baseUrl || 'http://127.0.0.1:8765'));
    if (existing && existing.statusCode && existing.statusCode < 500) {
      this.external = true;
      this.startedAt = new Date().toISOString();
      this.lastError = '';
      this.recentStderr = '';
      this.recentStdout = 'external desktop-agent detected on the configured port — reusing it';
      return this.getStatus();
    }
    this.external = false;
    this.child = this.spawnImpl(command, args, {
      stdio: 'pipe',
      windowsHide: true,
      // Pin the agent's output location to the CliGate data dir (cross-platform,
      // CWD-independent) instead of letting it fall back to `<cwd>/.tmp`. Both
      // the Node reader (messaging recovery) and this Python writer then resolve
      // the same directory via paths.js / DESKTOP_CONTROL_DIR.
      env: { ...process.env, DESKTOP_CONTROL_DIR: desktopControlDir() }
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
    // External (scheduled-task) agents are owned by the OS; do not try to kill
    // them from the dashboard process — we don't have rights and even if we
    // did, the next logon would resurrect them anyway. Just drop our handle.
    if (this.external) {
      this.external = false;
      this.startedAt = null;
      return this.getStatus();
    }
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
