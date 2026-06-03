import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';

import { CONFIG_DIR } from '../../account-manager.js';
import { redactSecrets, redactSecretsList } from '../../utils/redact-secrets.js';

// File-system assistant memory: one human-readable markdown file per memory,
// like CLAUDE.md / SKILL.md. No vectors, no database — recall is keyword + the
// LLM's own judgement (see keyword-match.js). Everything here is fail-safe: a
// read/parse/write error degrades to "no memory" rather than breaking the
// assistant.

export const MEMORY_KINDS = Object.freeze(['procedure', 'fact', 'directive', 'reference']);
export const MEMORY_RECALL_MODES = Object.freeze(['on-match', 'always']);

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => normalizeText(entry)).filter(Boolean))];
}

function normalizeKind(value) {
  const kind = normalizeText(value).toLowerCase();
  return MEMORY_KINDS.includes(kind) ? kind : 'fact';
}

function normalizeRecall(value) {
  const recall = normalizeText(value).toLowerCase();
  return MEMORY_RECALL_MODES.includes(recall) ? recall : 'on-match';
}

function normalizeConfidence(value) {
  const c = normalizeText(value).toLowerCase();
  return ['high', 'medium', 'low'].includes(c) ? c : 'medium';
}

// A stable signature for dedup: the same kind+topic+title is treated as the
// SAME memory and updated in place (so repeating a task evolves one file, not N).
export function signatureOf({ kind, topic, title } = {}) {
  const norm = (v) => normalizeText(v).toLowerCase().replace(/\s+/g, ' ');
  return `${normalizeKind(kind)}::${norm(topic)}::${norm(title)}`;
}

// Turn a title into a filesystem-safe, human-readable file stem. Keeps Unicode
// (incl. Chinese — modern filesystems are UTF-8) and only strips characters that
// are illegal in filenames.
function fileStemFromTitle(title) {
  const cleaned = normalizeText(title)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '') // illegal on Windows/POSIX
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || `mem-${randomUUID().slice(0, 8)}`;
}

function buildFrontmatterObject(record) {
  // Stable key order for readable diffs.
  return {
    id: record.id,
    title: record.title,
    kind: record.kind,
    recall: record.recall,
    keywords: record.keywords,
    topic: record.topic,
    scope: record.scope,
    confidence: record.confidence,
    usedCount: record.usedCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsed: record.lastUsed,
    lastVerified: record.lastVerified,
    source: record.source
  };
}

function serializeMemory(record) {
  const frontmatter = yaml.dump(buildFrontmatterObject(record), { lineWidth: 1000, noRefs: true }).trimEnd();
  const body = String(record.body || '').replace(/\s+$/, '');
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

function parseMemoryFile(source, { id }) {
  const text = String(source || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  let fm = {};
  try {
    fm = yaml.load(match[1]) || {};
  } catch {
    return null;
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return null;
  const body = match[2] || '';
  return normalizeRecord({
    id: normalizeText(fm.id) || id,
    title: fm.title,
    kind: fm.kind,
    recall: fm.recall,
    keywords: fm.keywords,
    topic: fm.topic,
    scope: fm.scope,
    confidence: fm.confidence,
    usedCount: fm.usedCount,
    createdAt: fm.createdAt,
    updatedAt: fm.updatedAt,
    lastUsed: fm.lastUsed,
    lastVerified: fm.lastVerified,
    source: fm.source,
    body
  });
}

function normalizeRecord(input = {}) {
  const created = normalizeText(input.createdAt) || nowIso();
  return {
    id: normalizeText(input.id),
    title: normalizeText(input.title),
    kind: normalizeKind(input.kind),
    recall: normalizeRecall(input.recall),
    keywords: normalizeStringList(input.keywords),
    topic: normalizeText(input.topic),
    scope: normalizeText(input.scope) || 'global',
    confidence: normalizeConfidence(input.confidence),
    usedCount: Math.max(0, Number(input.usedCount) || 0),
    createdAt: created,
    updatedAt: normalizeText(input.updatedAt) || created,
    lastUsed: normalizeText(input.lastUsed) || null,
    lastVerified: normalizeText(input.lastVerified) || null,
    source: normalizeText(input.source) || 'auto',
    body: String(input.body || '').trim()
  };
}

// A compact header for the recall shortlist / catalog — never includes the body.
export function toMemoryHeader(record) {
  return {
    id: record.id,
    title: record.title,
    kind: record.kind,
    recall: record.recall,
    topic: record.topic,
    keywords: record.keywords,
    confidence: record.confidence,
    usedCount: record.usedCount,
    lastUsed: record.lastUsed
  };
}

export class AssistantMemoryStore {
  constructor({ dir = join(CONFIG_DIR, 'agent-core', 'memories') } = {}) {
    this.dir = dir;
    this._records = null; // id -> record (lazy)
  }

  ensureDir() {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch {
      /* fail-safe */
    }
  }

  _ensureLoaded() {
    if (this._records) return;
    this._records = new Map();
    this.ensureDir();
    let files = [];
    try {
      files = readdirSync(this.dir).filter((name) => name.endsWith('.md'));
    } catch {
      files = [];
    }
    for (const name of files) {
      const id = name.replace(/\.md$/, '');
      try {
        const record = parseMemoryFile(readFileSync(join(this.dir, name), 'utf8'), { id });
        if (record && record.id && record.title) {
          this._records.set(record.id, record);
        }
      } catch {
        /* skip unreadable memory; never throw */
      }
    }
  }

  // Force a re-scan from disk (used by tests / after external edits).
  reload() {
    this._records = null;
    this._ensureLoaded();
    return this;
  }

  _writeRecord(record) {
    this.ensureDir();
    // Defense-in-depth: scrub credentials from anything we persist (G7). This is
    // the single write chokepoint, so explicit `remember`, auto-distilled, and
    // promoted memories are all covered.
    record.body = redactSecrets(record.body);
    record.keywords = redactSecretsList(record.keywords);
    const file = join(this.dir, `${record.id}.md`);
    writeFileSync(file, serializeMemory(record), { mode: 0o600 });
    this._records.set(record.id, record);
    return record;
  }

  list() {
    this._ensureLoaded();
    return [...this._records.values()];
  }

  get(id) {
    this._ensureLoaded();
    return this._records.get(normalizeText(id)) || null;
  }

  catalog() {
    return this.list().map(toMemoryHeader);
  }

  listAlways() {
    return this.list().filter((r) => r.recall === 'always');
  }

  findBySignature(sig) {
    this._ensureLoaded();
    const target = typeof sig === 'string' ? sig : signatureOf(sig);
    for (const record of this._records.values()) {
      if (signatureOf(record) === target) return record;
    }
    return null;
  }

  _allocateId(title) {
    const base = fileStemFromTitle(title);
    if (!this._records.has(base)) return base;
    // Collision with a different-signature memory → suffix to keep unique.
    return `${base}-${randomUUID().slice(0, 6)}`;
  }

  // Create or update-in-place a memory. Dedup is by signature (kind+topic+title):
  // a matching memory is reinforced (keywords unioned, body/confidence refreshed)
  // rather than duplicated — so repeating a task evolves one file.
  upsert(input = {}) {
    this._ensureLoaded();
    const title = normalizeText(input.title);
    if (!title) {
      throw new Error('memory requires a title');
    }
    const kind = normalizeKind(input.kind);
    const topic = normalizeText(input.topic);
    const existing = this.findBySignature({ kind, topic, title });
    const now = nowIso();

    if (existing) {
      const merged = normalizeRecord({
        ...existing,
        title,
        kind,
        topic,
        recall: input.recall != null ? input.recall : existing.recall,
        scope: input.scope != null ? input.scope : existing.scope,
        confidence: input.confidence != null ? input.confidence : existing.confidence,
        keywords: [...existing.keywords, ...normalizeStringList(input.keywords)],
        body: normalizeText(input.body) ? input.body : existing.body,
        source: input.source === 'user-pinned' ? 'user-pinned' : existing.source,
        createdAt: existing.createdAt,
        updatedAt: now,
        lastVerified: kind === 'procedure' && input.verified ? now : existing.lastVerified
      });
      merged.id = existing.id;
      return this._writeRecord(merged);
    }

    const record = normalizeRecord({
      ...input,
      title,
      kind,
      topic,
      createdAt: now,
      updatedAt: now,
      lastVerified: kind === 'procedure' && input.verified ? now : null,
      source: input.source || 'user-pinned'
    });
    record.id = normalizeText(input.id) || this._allocateId(title);
    return this._writeRecord(record);
  }

  // Bump usage stats on recall (cheap reinforcement signal for ranking).
  markUsed(id) {
    const record = this.get(id);
    if (!record) return null;
    record.usedCount = Number(record.usedCount || 0) + 1;
    record.lastUsed = nowIso();
    return this._writeRecord(record);
  }

  delete(id) {
    this._ensureLoaded();
    const key = normalizeText(id);
    const record = this._records.get(key);
    if (!record) return false;
    try {
      const file = join(this.dir, `${key}.md`);
      if (existsSync(file)) unlinkSync(file);
    } catch {
      /* fail-safe */
    }
    this._records.delete(key);
    return true;
  }
}

export const assistantMemoryStore = new AssistantMemoryStore();

export default assistantMemoryStore;
