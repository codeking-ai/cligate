import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

import { CONFIG_DIR } from '../../../src/account-manager.js';

export function parseArgs(argv = []) {
  const args = {
    dryRun: false,
    json: false,
    configDir: CONFIG_DIR
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = String(argv[index] || '').trim();
    if (current === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (current === '--json') {
      args.json = true;
      continue;
    }
    if (current === '--config-dir') {
      const next = String(argv[index + 1] || '').trim();
      if (next) {
        args.configDir = resolve(next);
        index += 1;
      }
    }
  }

  return args;
}

export function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, payload) {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

export function printResult(result, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`[assistant-migrate] ${result.summary}`);
  if (Array.isArray(result.lines)) {
    for (const line of result.lines) {
      console.log(`- ${line}`);
    }
  }
}

export function listConfigFiles(configDir) {
  return {
    configDir,
    supervisorTasksFile: join(configDir, 'agent-orchestrator', 'supervisor-tasks.json'),
    conversationsFile: join(configDir, 'agent-channels', 'conversations.json'),
    runtimeSessionsFile: join(configDir, 'agent-runtime', 'sessions.json'),
    approvalPoliciesFile: join(configDir, 'agent-runtime', 'approval-policies.json'),
    assistantDomainDir: join(configDir, 'assistant-domain')
  };
}

export function buildReportBase({ command = '', configDir = '', dryRun = false } = {}) {
  return {
    command,
    configDir,
    dryRun,
    generatedAt: new Date().toISOString()
  };
}
