import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import net from 'node:net';

export function parseIsolatedArgs(argv) {
  const options = {
    scenarioId: null,
    basePort: 8082,
    sourceConfigDir: join(homedir(), '.cligate'),
    isolatedConfigDir: join(process.cwd(), '.test-config'),
    allowLiveMutations: true,
    startupTimeoutMs: 30000
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--scenario') {
      options.scenarioId = argv[++i];
      continue;
    }
    if (arg === '--port') {
      options.basePort = Number(argv[++i]);
      continue;
    }
    if (arg === '--source-config') {
      options.sourceConfigDir = argv[++i];
      continue;
    }
    if (arg === '--isolated-config') {
      options.isolatedConfigDir = argv[++i];
      continue;
    }
    if (arg === '--startup-timeout-ms') {
      options.startupTimeoutMs = Number(argv[++i]);
    }
  }

  return options;
}

function ensureParentDir(filePath) {
  const normalized = filePath.replace(/[\\/][^\\/]+$/, '');
  if (normalized && !existsSync(normalized)) {
    mkdirSync(normalized, { recursive: true });
  }
}

export function prepareIsolatedConfig(options) {
  cpSync(options.sourceConfigDir, options.isolatedConfigDir, { recursive: true, force: true });

  const isolatedAuthDir = join(options.isolatedConfigDir, 'external-auth');
  const claudeCliConfigDir = join(options.isolatedConfigDir, 'claude-cli-config');
  mkdirSync(isolatedAuthDir, { recursive: true });
  mkdirSync(claudeCliConfigDir, { recursive: true });

  const codexAuthFile = join(isolatedAuthDir, 'codex-auth.json');
  const claudeCredentialsFile = join(isolatedAuthDir, 'claude-credentials.json');
  const sourceCodexAuth = join(homedir(), '.codex', 'auth.json');
  const sourceClaudeCredentials = join(homedir(), '.claude', '.credentials.json');

  if (existsSync(sourceCodexAuth)) {
    ensureParentDir(codexAuthFile);
    cpSync(sourceCodexAuth, codexAuthFile, { force: true });
  }

  if (existsSync(sourceClaudeCredentials)) {
    ensureParentDir(claudeCredentialsFile);
    cpSync(sourceClaudeCredentials, claudeCredentialsFile, { force: true });
  }

  return {
    codexAuthFile,
    claudeCredentialsFile,
    claudeCliConfigDir
  };
}

export async function resolvePort(preferredPort) {
  async function isPortFree(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.on('error', () => resolve(false));
      server.listen(port, () => {
        server.close(() => resolve(true));
      });
    });
  }

  if (await isPortFree(preferredPort)) {
    return preferredPort;
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : preferredPort;
      server.close(() => resolve(port));
    });
  });
}

export async function waitForHealth(baseUrl, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;

  while ((Date.now() - startedAt) < timeoutMs) {
    try {
      const response = await fetch(new URL('/health', baseUrl));
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for ${baseUrl}/health: ${lastError?.message || 'unknown error'}`);
}

export function startIsolatedServer(options, authFiles) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(options.basePort),
      PROXYPOOL_CONFIG_DIR: options.isolatedConfigDir,
      PROXYPOOL_CODEX_AUTH_FILE: authFiles.codexAuthFile,
      PROXYPOOL_CLAUDE_CREDENTIALS_FILE: authFiles.claudeCredentialsFile,
      CLAUDE_CONFIG_PATH: authFiles.claudeCliConfigDir
    }
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[isolated] ${chunk}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[isolated] ${chunk}`);
  });

  return child;
}

export async function stopIsolatedServer(child) {
  if (!child || child.killed) return;

  child.kill('SIGTERM');
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    child.once('exit', finish);
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      finish();
    }, 5000);
  });
}
