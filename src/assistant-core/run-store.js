import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';
import { createAssistantRun } from './models.js';
import { mergeJsonRecords } from './merge-json-records.js';

function nowIso() {
  return new Date().toISOString();
}

function jsonSize(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

// Slim a persisted run's heavy metadata for archival compaction. The full
// record is archived first (see _archiveRun), so this only mutates the HOT
// copy: it drops the multi-hundred-MB `metadata.toolResults` payloads
// (input/result/structured) — keeping just the light fields the router
// (artifactId) and summaries need — and collapses a non-resumable
// `metadata.checkpoint` to the light fields task-view-service reads.
function slimToolResults(toolResults) {
  if (!Array.isArray(toolResults)) return toolResults;
  return toolResults.map((entry) => {
    const slim = {
      toolName: String(entry?.toolName || ''),
      status: String(entry?.status || ''),
      summary: String(entry?.summary || '')
    };
    const artifactId = String(entry?.metadata?.artifactId || '').trim();
    if (artifactId) {
      slim.metadata = { artifactId };
    }
    return slim;
  });
}

function slimCheckpoint(checkpoint) {
  return {
    resumable: false,
    completedStepCount: Number(checkpoint?.completedStepCount || 0),
    pendingStepCount: Number(checkpoint?.pendingStepCount || 0),
    updatedAt: String(checkpoint?.updatedAt || '')
  };
}

function slimRun(run) {
  const metadata = run.metadata && typeof run.metadata === 'object' ? { ...run.metadata } : {};
  if (Array.isArray(metadata.toolResults)) {
    metadata.toolResults = slimToolResults(metadata.toolResults);
  }
  // Only slim a checkpoint that is NOT resumable — resumable checkpoints carry
  // the toolResults/plan needed to resume the run and must be preserved.
  if (metadata.checkpoint && typeof metadata.checkpoint === 'object' && metadata.checkpoint.resumable !== true) {
    metadata.checkpoint = slimCheckpoint(metadata.checkpoint);
  }
  metadata.compacted = true;
  return { ...run, metadata };
}

export class AssistantRunStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'assistant-core');
    this.file = join(this.rootDir, 'assistant-runs.json');
    this.archiveDir = join(this.rootDir, 'archives');
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

  _save({ skipMerge = false } = {}) {
    this.ensureDirs();
    // skipMerge is for authoritative rewrites (e.g. compaction) where re-reading
    // the on-disk file and union-merging would (a) re-read the full pre-compaction
    // file and (b) risk resurrecting the heavy fields we just slimmed. Mirrors the
    // skipMerge pattern in domain/store-utils.js used for removals. The default
    // merge protects against concurrent sibling writers for ordinary saves.
    if (!skipMerge) {
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
    }
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

  // Compact terminal, non-resumable runs older than `graceMs`: archive the full
  // record to a monthly JSONL, then SLIM the hot copy to drop the heavy
  // metadata.toolResults / metadata.checkpoint payloads (each ~140MB across the
  // store, and they mirror each other). The slimmed record stays queryable via
  // get/list with light fields + artifactId intact. Left untouched: in-flight /
  // waiting runs, failed+resumable runs (resume needs the checkpoint), runs
  // younger than the grace window, and already-compacted runs. Best-effort and
  // idempotent (metadata.compacted guards re-processing). Safe at startup.
  // graceMs defaults to 2h: compaction runs at STARTUP, when nothing is mid-flight
  // and all post-completion processing (memory distillation, artifact delivery)
  // from the previous process is already done — so a short window is safe and keeps
  // the hot file small even when recent days are full of large desktop-automation runs.
  compactRuns({ graceMs = 2 * 60 * 60 * 1000, archive = true, now = Date.now() } = {}) {
    const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
    let compacted = 0;
    let reclaimedBytes = 0;
    let changed = false;
    for (let i = 0; i < this.records.length; i += 1) {
      const run = this.records[i];
      if (!run || run?.metadata?.compacted === true) continue;
      const status = String(run.status || '').toLowerCase();
      if (!TERMINAL.has(status)) continue;
      // Never touch a run that can still be resumed (mirrors canResume()).
      if (status === 'failed' && run?.metadata?.checkpoint?.resumable === true) continue;
      const createdMs = Date.parse(String(run.createdAt || run.updatedAt || '')) || 0;
      if (!createdMs || (now - createdMs) <= graceMs) continue;

      const before = jsonSize(run);
      if (archive) {
        try {
          this._archiveRun(run);
        } catch {
          // If archiving fails we must NOT slim — never lose data. Skip this run.
          continue;
        }
      }
      this.records[i] = slimRun(run);
      reclaimedBytes += Math.max(0, before - jsonSize(this.records[i]));
      compacted += 1;
      changed = true;
    }
    if (changed) this._save({ skipMerge: true });
    return { compacted, reclaimedBytes };
  }

  _archiveRun(run) {
    if (!existsSync(this.archiveDir)) {
      mkdirSync(this.archiveDir, { recursive: true, mode: 0o700 });
    }
    const month = String(run.createdAt || run.updatedAt || '').slice(0, 7) || 'unknown';
    const file = join(this.archiveDir, `assistant-runs-${month}.jsonl`);
    appendFileSync(file, `${JSON.stringify(run)}\n`, { mode: 0o600 });
  }
}

export const assistantRunStore = new AssistantRunStore();

export default assistantRunStore;

