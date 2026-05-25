import EventEmitter from 'events';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';

function nowIso() {
  return new Date().toISOString();
}

function toText(value) {
  return String(value || '').trim();
}

function truncateText(value, limit = 4000) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  const head = Math.max(0, Math.floor(limit / 2));
  const tail = Math.max(0, limit - head);
  return `${text.slice(0, head)}\n...[truncated ${text.length - limit} chars]...\n${text.slice(-tail)}`;
}

function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizeValue(entry, depth + 1));
  }
  if (typeof value !== 'object') return undefined;
  if (depth >= 4) return '[object omitted]';

  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = String(key || '');
    if (/authorization|api[_-]?key|token|secret|password|cookie/i.test(normalizedKey)) {
      out[normalizedKey] = '[redacted]';
      continue;
    }
    out[normalizedKey] = sanitizeValue(entry, depth + 1);
  }
  return out;
}

function normalizeEventPayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return sanitizeValue(source) || {};
}

export class AssistantRunEventStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'assistant-core', 'run-events');
    this.emitter = new EventEmitter();
    this.seqByRunId = new Map();
    this.ensureDirs();
  }

  ensureDirs() {
    if (!existsSync(this.rootDir)) {
      mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    }
  }

  _file(runId) {
    return join(this.rootDir, `${runId}.jsonl`);
  }

  _readEvents(runId) {
    const normalizedRunId = toText(runId);
    if (!normalizedRunId) return [];
    const file = this._file(normalizedRunId);
    if (!existsSync(file)) return [];

    try {
      return readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  _nextSeq(runId) {
    const normalizedRunId = toText(runId);
    const current = Number(this.seqByRunId.get(normalizedRunId) || 0);
    if (current > 0) {
      const next = current + 1;
      this.seqByRunId.set(normalizedRunId, next);
      return next;
    }

    const last = this._readEvents(normalizedRunId)
      .reduce((max, event) => Math.max(max, Number(event?.seq || 0)), 0);
    const next = last + 1;
    this.seqByRunId.set(normalizedRunId, next);
    return next;
  }

  append(runId, {
    type,
    phase = '',
    status = '',
    title = '',
    summary = '',
    payload = {},
    visibility = 'detail'
  } = {}) {
    const normalizedRunId = toText(runId);
    const normalizedType = toText(type);
    if (!normalizedRunId || !normalizedType) return null;

    this.ensureDirs();
    const event = {
      runId: normalizedRunId,
      seq: this._nextSeq(normalizedRunId),
      ts: nowIso(),
      type: normalizedType,
      phase: toText(phase),
      status: toText(status),
      title: truncateText(title, 240),
      summary: truncateText(summary, 1000),
      payload: normalizeEventPayload(payload),
      visibility: ['compact', 'detail', 'debug', 'hidden'].includes(toText(visibility))
        ? toText(visibility)
        : 'detail'
    };

    appendFileSync(this._file(normalizedRunId), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    this.emitter.emit(normalizedRunId, event);
    this.emitter.emit('*', event);
    return event;
  }

  list(runId, { afterSeq = 0, limit = 200 } = {}) {
    const normalizedAfterSeq = Number(afterSeq || 0);
    const normalizedLimit = Math.max(0, Number(limit || 200));
    return this._readEvents(runId)
      .filter((event) => Number(event?.seq || 0) > normalizedAfterSeq)
      .slice(-normalizedLimit);
  }

  subscribe(runId, listener) {
    const normalizedRunId = toText(runId);
    this.emitter.on(normalizedRunId, listener);
    return () => this.emitter.off(normalizedRunId, listener);
  }
}

export const assistantRunEventStore = new AssistantRunEventStore();

export default assistantRunEventStore;
