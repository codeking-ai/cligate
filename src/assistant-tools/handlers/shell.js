import { spawn } from 'node:child_process';

function clampInteger(value, { fallback, min, max }) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function createShellToolHandlers({ workspaceGuard }) {
  return {
    async runShellCommand({ input = {}, context = {} } = {}) {
      const command = String(input.command || '').trim();
      if (!command) {
        throw new Error('run_shell_command requires command');
      }
      const cwd = workspaceGuard.resolvePath(input.cwd || '.', {
        baseDir: context.cwd || workspaceGuard.workspaceRoot
      });
      const timeoutMs = clampInteger(input.timeoutMs, { fallback: 15000, min: 1, max: 300000 });
      const maxBytes = clampInteger(input.maxBytes, { fallback: 65536, min: 256, max: 1048576 });

      return new Promise((resolve, reject) => {
        const child = spawn(command, {
          cwd,
          shell: true,
          windowsHide: true,
          env: process.env
        });

        let stdout = '';
        let stderr = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let timedOut = false;
        let settled = false;

        const appendChunk = (current, chunk) => {
          const next = current + chunk;
          if (Buffer.byteLength(next, 'utf8') <= maxBytes) {
            return { text: next, truncated: false };
          }
          const truncated = Buffer.from(next, 'utf8').subarray(0, maxBytes).toString('utf8');
          return { text: truncated, truncated: true };
        };

        const finish = (payload) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(payload);
        };

        const timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill();
          } catch {
            // ignore kill races
          }
        }, timeoutMs);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }

        child.stdout.on('data', (chunk) => {
          const updated = appendChunk(stdout, chunk.toString());
          stdout = updated.text;
          stdoutTruncated = stdoutTruncated || updated.truncated;
        });

        child.stderr.on('data', (chunk) => {
          const updated = appendChunk(stderr, chunk.toString());
          stderr = updated.text;
          stderrTruncated = stderrTruncated || updated.truncated;
        });

        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });

        child.on('close', (exitCode, signal) => {
          finish({
            command,
            cwd: workspaceGuard.toWorkspaceRelative(cwd),
            exitCode,
            signal,
            timedOut,
            stdout,
            stderr,
            stdoutTruncated,
            stderrTruncated,
            success: exitCode === 0 && !timedOut
          });
        });
      });
    }
  };
}

export default createShellToolHandlers;
