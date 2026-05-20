import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../../account-manager.js';
import { mergeJsonRecords } from '../merge-json-records.js';

export class JsonEntityStore {
  constructor({
    configDir = CONFIG_DIR,
    dirName = 'assistant-domain',
    fileName,
    rootKey,
    keyOf = (entry) => entry?.id
  } = {}) {
    this.rootDir = join(configDir, dirName);
    this.file = join(this.rootDir, fileName);
    this.rootKey = rootKey;
    this.keyOf = keyOf;
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
      return Array.isArray(parsed?.[this.rootKey]) ? parsed[this.rootKey] : [];
    } catch {
      return [];
    }
  }

  _save({ skipMerge = false } = {}) {
    this.ensureDirs();
    if (!skipMerge) {
      let diskRecords = [];
      if (existsSync(this.file)) {
        try {
          const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
          diskRecords = Array.isArray(parsed?.[this.rootKey]) ? parsed[this.rootKey] : [];
        } catch {
          diskRecords = [];
        }
      }
      this.records = mergeJsonRecords({
        currentRecords: this.records,
        diskRecords,
        keyOf: this.keyOf
      });
    }
    writeFileSync(
      this.file,
      JSON.stringify({ [this.rootKey]: this.records }, null, 2),
      { mode: 0o600 }
    );
  }

  list({ limit = 100, predicate = null, sortBy = 'updatedAt' } = {}) {
    const source = typeof predicate === 'function'
      ? this.records.filter((entry) => predicate(entry))
      : this.records;
    return [...source]
      .sort((left, right) => String(right?.[sortBy] || '').localeCompare(String(left?.[sortBy] || '')))
      .slice(0, Math.max(1, limit));
  }

  get(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    return this.records.find((entry) => String(this.keyOf(entry)) === key) || null;
  }

  save(record) {
    const key = String(this.keyOf(record) || '').trim();
    if (!key) {
      throw new Error('record key is required');
    }
    const index = this.records.findIndex((entry) => String(this.keyOf(entry)) === key);
    if (index >= 0) {
      this.records[index] = record;
    } else {
      this.records.push(record);
    }
    this._save();
    return record;
  }

  remove(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    const index = this.records.findIndex((entry) => String(this.keyOf(entry)) === key);
    if (index < 0) return null;
    const [removed] = this.records.splice(index, 1);
    // Skip the merge-with-disk step: mergeJsonRecords is a union, so re-reading
    // the file and unioning would resurrect the just-removed record from disk.
    // The merge is intended to protect concurrent writes from sibling store
    // instances, which our singletons don't have.
    this._save({ skipMerge: true });
    return removed;
  }
}

export default JsonEntityStore;
