import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../account-manager.js';
import { getDesktopAgentSettings, setDesktopAgentSettings } from './settings.js';

const TOKEN_FILE = join(CONFIG_DIR, 'desktop-agent.token');

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function readDesktopAgentToken() {
  const configured = String(getDesktopAgentSettings().token || '').trim();
  if (configured) {
    return configured;
  }
  ensureConfigDir();
  if (!existsSync(TOKEN_FILE)) {
    return '';
  }
  try {
    return String(readFileSync(TOKEN_FILE, 'utf8') || '').trim();
  } catch {
    return '';
  }
}

export function ensureDesktopAgentToken() {
  const existing = readDesktopAgentToken();
  if (existing) {
    return existing;
  }
  ensureConfigDir();
  const token = randomBytes(24).toString('hex');
  writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  setDesktopAgentSettings({ token });
  return token;
}

export { TOKEN_FILE };

export default {
  readDesktopAgentToken,
  ensureDesktopAgentToken,
  TOKEN_FILE
};
