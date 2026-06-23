/**
 * Tier-3 model-entry persistence (independent of the chat API-key pool).
 *
 * Reuses the robust JsonEntityStore (atomic write + concurrent-merge) for the
 * `models` array, and keeps a tiny sibling `settings.json` for global toggles.
 * Both live under ~/.cligate/image-gen/. Secrets (apiKey) are masked on read
 * via toSafeModel() and preserved-on-omit during updates, mirroring the MCP
 * config-store redaction pattern.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { CONFIG_DIR } from '../account-manager.js';
import { JsonEntityStore } from '../assistant-core/domain/store-utils.js';

const DIR_NAME = 'image-gen';

export const DEFAULT_SETTINGS = Object.freeze({
  requireApproval: true,   // cloud image gen costs money — gate by default
  defaultModelId: '',
  maxImagesPerCall: 4
});

function nowIso() {
  return new Date().toISOString();
}

function toText(value) {
  return String(value ?? '').trim();
}

function maskKey(apiKey) {
  const key = toText(apiKey);
  if (!key) return '';
  const last4 = key.slice(-4);
  return `••••${last4}`;
}

function isOmittedSecret(value) {
  // Treat empty / undefined / a masked echo as "keep existing".
  const v = toText(value);
  return v === '' || v.includes('•') || v === '[redacted]';
}

function normalizeModelEntry(payload = {}) {
  const now = nowIso();
  return {
    id: toText(payload.id) || `img_${randomUUID()}`,
    displayName: toText(payload.displayName) || 'Image model',
    enabled: payload.enabled !== false,
    backendKind: toText(payload.backendKind) || 'openai-images',
    baseUrl: toText(payload.baseUrl),
    apiKey: toText(payload.apiKey),
    nativeModel: toText(payload.nativeModel),
    defaultParams: (payload.defaultParams && typeof payload.defaultParams === 'object' && !Array.isArray(payload.defaultParams))
      ? { ...payload.defaultParams }
      : {},
    capabilities: (payload.capabilities && typeof payload.capabilities === 'object' && !Array.isArray(payload.capabilities))
      ? { ...payload.capabilities }
      : {},
    pricing: (payload.pricing && typeof payload.pricing === 'object' && !Array.isArray(payload.pricing))
      ? { ...payload.pricing }
      : {},
    totalRequests: Number(payload.totalRequests) || 0,
    totalImages: Number(payload.totalImages) || 0,
    totalCost: Number(payload.totalCost) || 0,
    errors: Number(payload.errors) || 0,
    lastUsedAt: toText(payload.lastUsedAt),
    createdAt: toText(payload.createdAt) || now,
    updatedAt: now
  };
}

export function toSafeModel(entry = {}) {
  const { apiKey, ...rest } = entry;
  return { ...rest, apiKey: maskKey(apiKey), hasApiKey: Boolean(toText(apiKey)) };
}

export class ImageGenModelStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.store = new JsonEntityStore({ configDir, dirName: DIR_NAME, fileName: 'models.json', rootKey: 'models' });
    this.settingsFile = join(configDir, DIR_NAME, 'settings.json');
  }

  // ── settings ────────────────────────────────────────────────────────────
  getSettings() {
    if (!existsSync(this.settingsFile)) return { ...DEFAULT_SETTINGS };
    try {
      const parsed = JSON.parse(readFileSync(this.settingsFile, 'utf8'));
      return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  setSettings(patch = {}) {
    const next = { ...this.getSettings() };
    if (typeof patch.requireApproval === 'boolean') next.requireApproval = patch.requireApproval;
    if (patch.defaultModelId !== undefined) next.defaultModelId = toText(patch.defaultModelId);
    if (patch.maxImagesPerCall !== undefined) {
      const n = Number.parseInt(patch.maxImagesPerCall, 10);
      if (Number.isFinite(n)) next.maxImagesPerCall = Math.min(4, Math.max(1, n));
    }
    const dir = join(this.settingsFile, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.settingsFile, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
  }

  // ── CRUD ────────────────────────────────────────────────────────────────
  listModels({ includeSecrets = false } = {}) {
    const models = this.store.list({ limit: 500 });
    return includeSecrets ? models : models.map(toSafeModel);
  }

  getModel(id, { includeSecrets = false } = {}) {
    const entry = this.store.get(id);
    if (!entry) return null;
    return includeSecrets ? entry : toSafeModel(entry);
  }

  addModel(payload = {}) {
    const entry = normalizeModelEntry(payload);
    this.store.save(entry);
    return toSafeModel(entry);
  }

  updateModel(id, patch = {}) {
    const existing = this.store.get(id);
    if (!existing) return null;
    const merged = { ...existing };
    const fields = ['displayName', 'backendKind', 'baseUrl', 'nativeModel'];
    for (const f of fields) {
      if (patch[f] !== undefined) merged[f] = toText(patch[f]);
    }
    if (typeof patch.enabled === 'boolean') merged.enabled = patch.enabled;
    if (patch.defaultParams !== undefined) merged.defaultParams = patch.defaultParams;
    if (patch.capabilities !== undefined) merged.capabilities = patch.capabilities;
    if (patch.pricing !== undefined) merged.pricing = patch.pricing;
    // Secret: only overwrite when a real new key was supplied.
    if (patch.apiKey !== undefined && !isOmittedSecret(patch.apiKey)) {
      merged.apiKey = toText(patch.apiKey);
    }
    const normalized = normalizeModelEntry({ ...merged, id: existing.id, createdAt: existing.createdAt });
    this.store.save(normalized);
    return toSafeModel(normalized);
  }

  removeModel(id) {
    const removed = this.store.remove(id);
    const settings = this.getSettings();
    if (removed && settings.defaultModelId === removed.id) {
      this.setSettings({ defaultModelId: '' });
    }
    return removed ? toSafeModel(removed) : null;
  }

  // ── selection ─────────────────────────────────────────────────────────────
  /**
   * Resolve the model entry (WITH secrets) to use for a request.
   * Preference: explicit id → configured default → first enabled.
   * Returns null when nothing usable is configured.
   */
  resolveModel(modelId = '') {
    const wanted = toText(modelId);
    if (wanted) {
      const entry = this.store.get(wanted);
      return entry && entry.enabled !== false ? entry : (entry || null);
    }
    const settings = this.getSettings();
    if (settings.defaultModelId) {
      const def = this.store.get(settings.defaultModelId);
      if (def && def.enabled !== false) return def;
    }
    return this.store.list({ limit: 500 }).find((m) => m.enabled !== false) || null;
  }

  // ── usage bookkeeping ─────────────────────────────────────────────────────
  recordModelUsage(id, { images = 0, cost = 0 } = {}) {
    const entry = this.store.get(id);
    if (!entry) return null;
    const next = normalizeModelEntry({
      ...entry,
      id: entry.id,
      createdAt: entry.createdAt,
      totalRequests: (Number(entry.totalRequests) || 0) + 1,
      totalImages: (Number(entry.totalImages) || 0) + Math.max(0, Number(images) || 0),
      totalCost: Number(((Number(entry.totalCost) || 0) + (Number(cost) || 0)).toFixed(6)),
      lastUsedAt: nowIso()
    });
    this.store.save(next);
    return next;
  }

  recordModelError(id) {
    const entry = this.store.get(id);
    if (!entry) return null;
    const next = normalizeModelEntry({
      ...entry,
      id: entry.id,
      createdAt: entry.createdAt,
      errors: (Number(entry.errors) || 0) + 1,
      lastUsedAt: nowIso()
    });
    this.store.save(next);
    return next;
  }
}

export const imageGenModelStore = new ImageGenModelStore();

export default imageGenModelStore;
