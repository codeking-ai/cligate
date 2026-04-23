import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';
import { mergeJsonRecords } from './merge-json-records.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeKind(value) {
  return normalizeText(value).toLowerCase();
}

export class AssistantRuntimeSessionMemoryStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'assistant-core');
    this.file = join(this.rootDir, 'runtime-session-memory.json');
    this.ensureDirs();
    this.records = this._load();
  }

  ensureDirs() {
    if (!existsSync(this.rootDir)) {
      mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    }
  }

  _load() {
    this.ensureDirs();
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed?.records) ? parsed.records : [];
    } catch {
      return [];
    }
  }

  _save() {
    this.ensureDirs();
    let diskRecords = [];
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
        diskRecords = Array.isArray(parsed?.records) ? parsed.records : [];
      } catch {
        diskRecords = [];
      }
    }
    this.records = mergeJsonRecords({
      currentRecords: this.records,
      diskRecords,
      keyOf: (entry) => `${entry?.sessionId || ''}:${entry?.key || ''}`
    });
    writeFileSync(
      this.file,
      JSON.stringify({ records: this.records }, null, 2),
      { mode: 0o600 }
    );
  }

  listBySession(sessionId, { kind = '', limit = 200 } = {}) {
    const normalizedSessionId = normalizeText(sessionId);
    const normalizedKind = normalizeKind(kind);
    if (!normalizedSessionId) return [];
    return this.records
      .filter((entry) => entry.sessionId === normalizedSessionId)
      .filter((entry) => !normalizedKind || entry.kind === normalizedKind)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, Math.max(1, limit));
  }

  get(sessionId, key) {
    const normalizedSessionId = normalizeText(sessionId);
    const normalizedKey = normalizeText(key);
    if (!normalizedSessionId || !normalizedKey) return null;
    return this.records.find((entry) => entry.sessionId === normalizedSessionId && entry.key === normalizedKey) || null;
  }

  upsert({
    sessionId,
    kind,
    key,
    value = null,
    metadata = {}
  } = {}) {
    const normalizedSessionId = normalizeText(sessionId);
    const normalizedKind = normalizeKind(kind);
    const normalizedKey = normalizeText(key);
    if (!normalizedSessionId || !normalizedKind || !normalizedKey) return null;

    const now = nowIso();
    const current = this.get(normalizedSessionId, normalizedKey);
    const next = {
      sessionId: normalizedSessionId,
      kind: normalizedKind,
      key: normalizedKey,
      value,
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      createdAt: current?.createdAt || now,
      updatedAt: now
    };
    const index = this.records.findIndex((entry) => entry.sessionId === normalizedSessionId && entry.key === normalizedKey);
    if (index >= 0) {
      this.records[index] = next;
    } else {
      this.records.push(next);
    }
    this._save();
    return next;
  }
}

export const assistantRuntimeSessionMemoryStore = new AssistantRuntimeSessionMemoryStore();

export default assistantRuntimeSessionMemoryStore;
