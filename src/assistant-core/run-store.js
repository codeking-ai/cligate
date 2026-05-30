import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';
import { createAssistantRun } from './models.js';
import { mergeJsonRecords } from './merge-json-records.js';

function nowIso() {
  return new Date().toISOString();
}

export class AssistantRunStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'assistant-core');
    this.file = join(this.rootDir, 'assistant-runs.json');
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
      return Array.isArray(parsed?.runs) ? parsed.runs : [];
    } catch {
      return [];
    }
  }

  _save() {
    this.ensureDirs();
    let diskRuns = [];
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
        diskRuns = Array.isArray(parsed?.runs) ? parsed.runs : [];
      } catch {
        diskRuns = [];
      }
    }
    this.records = mergeJsonRecords({
      currentRecords: this.records,
      diskRecords: diskRuns,
      keyOf: (entry) => entry?.id
    });
    writeFileSync(
      this.file,
      JSON.stringify({ runs: this.records }, null, 2),
      { mode: 0o600 }
    );
  }

  list({ assistantSessionId, limit = 100 } = {}) {
    return this.records
      .filter((entry) => !assistantSessionId || entry.assistantSessionId === String(assistantSessionId))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, Math.max(1, limit));
  }

  listByConversationId(conversationId, { limit = 100 } = {}) {
    return this.records
      .filter((entry) => entry.conversationId === String(conversationId || ''))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, Math.max(1, limit));
  }

  get(runId) {
    return this.records.find((entry) => entry.id === String(runId || '')) || null;
  }

  canResume(runId) {
    const run = this.get(runId);
    if (!run) return false;
    return run.status === 'failed' && run?.metadata?.checkpoint?.resumable === true;
  }

  save(run) {
    const updated = {
      ...run,
      updatedAt: nowIso()
    };
    const index = this.records.findIndex((entry) => entry.id === updated.id);
    if (index >= 0) {
      this.records[index] = updated;
    } else {
      this.records.push(updated);
    }
    this._save();
    return updated;
  }

  create(payload = {}) {
    return this.save(createAssistantRun(payload));
  }

  // Retire long-abandoned non-terminal runs by marking them failed, so they
  // stop being treated as "active" (surfaced to the supervisor / blocking new
  // work). Guarded: only runs whose createdAt is older than `olderThanMs` are
  // touched, so genuinely in-flight runs are never swept. Returns the count of
  // runs retired. Idempotent and safe to call at startup.
  failStaleNonTerminalRuns({ olderThanMs = 24 * 60 * 60 * 1000, reason = 'stale_nonterminal_cleanup', now = Date.now() } = {}) {
    const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
    let count = 0;
    for (const run of this.records) {
      if (!run || TERMINAL.has(String(run.status || '').toLowerCase())) continue;
      const createdMs = Date.parse(String(run.createdAt || run.updatedAt || '')) || 0;
      if (!createdMs || (now - createdMs) <= olderThanMs) continue;
      run.status = 'failed';
      run.updatedAt = nowIso();
      run.metadata = {
        ...(run.metadata && typeof run.metadata === 'object' ? run.metadata : {}),
        staleCleanup: { reason, sweptAt: nowIso(), ageMs: now - createdMs }
      };
      count += 1;
    }
    if (count > 0) this._save();
    return count;
  }
}

export const assistantRunStore = new AssistantRunStore();

export default assistantRunStore;

