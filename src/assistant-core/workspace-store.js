import crypto from 'crypto';
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

export class AssistantWorkspaceStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'assistant-core');
    this.file = join(this.rootDir, 'workspaces.json');
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
      return Array.isArray(parsed?.workspaces) ? parsed.workspaces : [];
    } catch {
      return [];
    }
  }

  _save() {
    this.ensureDirs();
    let diskWorkspaces = [];
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
        diskWorkspaces = Array.isArray(parsed?.workspaces) ? parsed.workspaces : [];
      } catch {
        diskWorkspaces = [];
      }
    }
    this.records = mergeJsonRecords({
      currentRecords: this.records,
      diskRecords: diskWorkspaces,
      keyOf: (entry) => entry?.id
    });
    writeFileSync(
      this.file,
      JSON.stringify({ workspaces: this.records }, null, 2),
      { mode: 0o600 }
    );
  }

  list({ limit = 100 } = {}) {
    return this.records
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, Math.max(1, limit));
  }

  getByRef(workspaceRef) {
    const normalizedRef = normalizeText(workspaceRef);
    if (!normalizedRef) return null;
    return this.records.find((entry) => entry.workspaceRef === normalizedRef) || null;
  }

  findOrCreate({ workspaceRef, metadata = {} } = {}) {
    const normalizedRef = normalizeText(workspaceRef);
    if (!normalizedRef) return null;

    const existing = this.getByRef(normalizedRef);
    if (existing) {
      return existing;
    }

    const record = {
      id: crypto.randomUUID(),
      workspaceRef: normalizedRef,
      name: normalizeText(metadata?.name) || normalizedRef,
      defaultRuntimeProvider: normalizeText(metadata?.defaultRuntimeProvider),
      allowedScopeBoundary: normalizeText(metadata?.allowedScopeBoundary) || normalizedRef,
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    this.records.push(record);
    this._save();
    return record;
  }

  upsert({ workspaceRef, patch = {} } = {}) {
    const normalizedRef = normalizeText(workspaceRef);
    if (!normalizedRef) return null;

    const current = this.findOrCreate({ workspaceRef: normalizedRef, metadata: patch });
    const next = {
      ...current,
      workspaceRef: normalizedRef,
      name: normalizeText(patch?.name) || current.name || normalizedRef,
      defaultRuntimeProvider: normalizeText(patch?.defaultRuntimeProvider) || current.defaultRuntimeProvider || '',
      allowedScopeBoundary: normalizeText(patch?.allowedScopeBoundary) || current.allowedScopeBoundary || normalizedRef,
      metadata: {
        ...(current.metadata || {}),
        ...((patch?.metadata && typeof patch.metadata === 'object') ? patch.metadata : {})
      },
      updatedAt: nowIso()
    };

    const index = this.records.findIndex((entry) => entry.id === current.id);
    if (index >= 0) {
      this.records[index] = next;
    } else {
      this.records.push(next);
    }
    this._save();
    return next;
  }
}

export const assistantWorkspaceStore = new AssistantWorkspaceStore();

export default assistantWorkspaceStore;
