import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { CONFIG_DIR } from '../../../account-manager.js';

const WEIXIN_STATE_DIR = join(CONFIG_DIR, 'agent-channels', 'weixin');
const ACCOUNTS_INDEX_FILE = join(WEIXIN_STATE_DIR, 'accounts.json');
const ACCOUNTS_DIR = join(WEIXIN_STATE_DIR, 'accounts');

function ensureStateDir() {
  if (!existsSync(ACCOUNTS_DIR)) {
    mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
  }
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function isBlockedObjectKey(value) {
  return value === '__proto__' || value === 'prototype' || value === 'constructor';
}

export function normalizeWeixinAccountId(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return 'default';
  const lowered = trimmed.toLowerCase();
  const normalized = /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)
    ? lowered
    : lowered
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 64);
  return normalized && !isBlockedObjectKey(normalized) ? normalized : 'default';
}

function accountFile(accountId) {
  return join(ACCOUNTS_DIR, `${normalizeWeixinAccountId(accountId)}.json`);
}

function syncFile(accountId) {
  return join(ACCOUNTS_DIR, `${normalizeWeixinAccountId(accountId)}.sync.json`);
}

function contextTokensFile(accountId) {
  return join(ACCOUNTS_DIR, `${normalizeWeixinAccountId(accountId)}.context-tokens.json`);
}

export class WeixinAccountStore {
  constructor({ stateDir = WEIXIN_STATE_DIR } = {}) {
    this.stateDir = stateDir;
    this.accountsIndexFile = join(stateDir, 'accounts.json');
    this.accountsDir = join(stateDir, 'accounts');
  }

  accountFile(accountId) {
    return join(this.accountsDir, `${normalizeWeixinAccountId(accountId)}.json`);
  }

  syncFile(accountId) {
    return join(this.accountsDir, `${normalizeWeixinAccountId(accountId)}.sync.json`);
  }

  contextTokensFile(accountId) {
    return join(this.accountsDir, `${normalizeWeixinAccountId(accountId)}.context-tokens.json`);
  }

  ensure() {
    if (!existsSync(this.accountsDir)) {
      mkdirSync(this.accountsDir, { recursive: true, mode: 0o700 });
    }
  }

  listAccountIds() {
    const data = readJsonFile(this.accountsIndexFile, []);
    return Array.isArray(data)
      ? data.map((id) => normalizeWeixinAccountId(id)).filter(Boolean)
      : [];
  }

  registerAccount(accountId) {
    this.ensure();
    const id = normalizeWeixinAccountId(accountId);
    const existing = this.listAccountIds();
    if (!existing.includes(id)) {
      writeJsonFile(this.accountsIndexFile, [...existing, id]);
    }
    return id;
  }

  saveAccount(accountId, patch = {}) {
    this.ensure();
    const id = this.registerAccount(accountId);
    const current = this.readAccount(id) || {};
    const next = {
      ...current,
      ...(patch.token ? { token: String(patch.token).trim() } : {}),
      ...(patch.baseUrl ? { baseUrl: String(patch.baseUrl).trim() } : {}),
      ...(patch.userId ? { userId: String(patch.userId).trim() } : {}),
      savedAt: new Date().toISOString()
    };
    writeJsonFile(this.accountFile(id), next);
    return { accountId: id, ...next };
  }

  readAccount(accountId) {
    const id = normalizeWeixinAccountId(accountId);
    const data = readJsonFile(this.accountFile(id), null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return {
      accountId: id,
      token: typeof data.token === 'string' ? data.token.trim() : '',
      baseUrl: typeof data.baseUrl === 'string' ? data.baseUrl.trim() : '',
      userId: typeof data.userId === 'string' ? data.userId.trim() : '',
      savedAt: typeof data.savedAt === 'string' ? data.savedAt : ''
    };
  }

  deleteAccount(accountId) {
    const id = normalizeWeixinAccountId(accountId);
    for (const filePath of [this.accountFile(id), this.syncFile(id), this.contextTokensFile(id)]) {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // best effort
      }
    }
    const next = this.listAccountIds().filter((entry) => entry !== id);
    writeJsonFile(this.accountsIndexFile, next);
  }

  readSyncCursor(accountId) {
    const data = readJsonFile(this.syncFile(accountId), {});
    return typeof data?.get_updates_buf === 'string' ? data.get_updates_buf : '';
  }

  saveSyncCursor(accountId, cursor) {
    this.ensure();
    writeJsonFile(this.syncFile(accountId), {
      get_updates_buf: String(cursor || '')
    });
  }

  readContextTokens(accountId) {
    const data = readJsonFile(this.contextTokensFile(accountId), {});
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }

  saveContextToken(accountId, userId, token) {
    const normalizedUserId = String(userId || '').trim();
    const normalizedToken = String(token || '').trim();
    if (!normalizedUserId || !normalizedToken) return;
    const tokens = this.readContextTokens(accountId);
    tokens[normalizedUserId] = normalizedToken;
    writeJsonFile(this.contextTokensFile(accountId), tokens);
  }

  getContextToken(accountId, userId) {
    const tokens = this.readContextTokens(accountId);
    const token = tokens[String(userId || '').trim()];
    return typeof token === 'string' ? token.trim() : '';
  }
}

export const weixinAccountStore = new WeixinAccountStore();

export {
  WEIXIN_STATE_DIR,
  ACCOUNTS_INDEX_FILE,
  ACCOUNTS_DIR,
  accountFile,
  syncFile,
  contextTokensFile,
  ensureStateDir
};

export default weixinAccountStore;
