import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!globalThis.__cligateTestEnvRoot) {
  globalThis.__cligateTestEnvRoot = mkdtempSync(join(tmpdir(), 'cligate-test-env-'));
}

const root = globalThis.__cligateTestEnvRoot;
const cligateDir = join(root, '.cligate');
const claudeDir = join(root, '.claude');
const codexDir = join(root, '.codex');

mkdirSync(cligateDir, { recursive: true });
mkdirSync(claudeDir, { recursive: true });
mkdirSync(codexDir, { recursive: true });

process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.CLIGATE_CONFIG_DIR = cligateDir;
process.env.CLAUDE_CONFIG_PATH = claudeDir;
process.env.CLIGATE_CODEX_AUTH_FILE = join(codexDir, 'auth.json');
process.env.CLIGATE_CLAUDE_CREDENTIALS_FILE = join(claudeDir, '.credentials.json');
