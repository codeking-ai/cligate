/**
 * Tier-2 backend contract + registry.
 *
 * A backend adapter encapsulates everything provider-specific: which canonical
 * params it supports, how to translate them to the upstream's native shape, and
 * how to call the upstream. Adding a provider = register one backend here; the
 * canonical tool surface (Tier-1) and the model store (Tier-3) never change.
 *
 * Contract each backend object/instance must satisfy:
 *   - kind: string                      // matches a model entry's `backendKind`
 *   - capabilities(entry): object       // { negativePrompt, seed, maxN, aspectRatios }
 *   - mapParams(canonical, entry): { native, notes }  // translate + degrade
 *   - generate({ native, entry, signal }): Promise<{ images, model, usage }>
 *       images: [{ base64?, url?, mediaType }]
 *
 * Upstream failures should throw an ImageBackendError so the service can map
 * them onto runtime-state the same way the chatgpt-responses executor does.
 */

export const IMAGE_ERROR = Object.freeze({
  AUTH: 'AUTH_EXPIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  UPSTREAM: 'UPSTREAM_ERROR'
});

export class ImageBackendError extends Error {
  constructor(message, { code = IMAGE_ERROR.UPSTREAM, status = 0, retryAfterMs = 0 } = {}) {
    super(message || 'image backend error');
    this.name = 'ImageBackendError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parse an HTTP Retry-After header (seconds) into ms, with a fallback.
 */
export function parseRetryAfterMs(headers, fallbackMs = 60_000) {
  const seconds = Number.parseInt(headers?.get?.('retry-after'), 10);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return fallbackMs;
}

/**
 * Build a coded ImageBackendError from a non-OK fetch Response, so every
 * backend maps upstream HTTP failures onto runtime-state identically. Handles
 * both the OpenAI-shaped `{error:{message}}` and DashScope-shaped
 * `{code,message}` error bodies.
 */
export async function imageErrorFromResponse(response) {
  const status = response.status;
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || body?.message || JSON.stringify(body?.error || body);
  } catch {
    detail = await response.text().catch(() => '');
  }
  if (status === 401 || status === 403) {
    return new ImageBackendError(`auth failed: ${detail}`, { code: IMAGE_ERROR.AUTH, status });
  }
  if (status === 429) {
    return new ImageBackendError(`rate limited: ${detail}`, {
      code: IMAGE_ERROR.RATE_LIMITED,
      status,
      retryAfterMs: parseRetryAfterMs(response.headers)
    });
  }
  if (status === 400 || status === 422) {
    return new ImageBackendError(`invalid request: ${detail}`, { code: IMAGE_ERROR.INVALID_REQUEST, status });
  }
  return new ImageBackendError(`upstream error ${status}: ${detail}`, { code: IMAGE_ERROR.UPSTREAM, status });
}

/**
 * Default capability profile. A backend overrides what it can't do; a model
 * entry may further override via `entry.capabilities`.
 */
export function defaultCapabilities() {
  return {
    negativePrompt: true,
    seed: true,
    maxN: 4,
    qualities: ['draft', 'standard', 'high']
  };
}

export function resolveCapabilities(backend, entry = {}) {
  const base = { ...defaultCapabilities(), ...(backend?.capabilities?.(entry) || {}) };
  const overrides = (entry.capabilities && typeof entry.capabilities === 'object') ? entry.capabilities : {};
  return { ...base, ...overrides };
}

/**
 * Drop canonical fields the resolved capabilities don't support, recording an
 * honest note for each — never silently pretend an unsupported param was used.
 * Returns a shallow-cloned canonical so the caller's object is untouched.
 */
export function degradeCanonical(canonical = {}, capabilities = {}) {
  const next = { ...canonical };
  const notes = [];
  if (next.negativePrompt && capabilities.negativePrompt === false) {
    notes.push('This model ignores negativePrompt — it was dropped.');
    next.negativePrompt = '';
  }
  if (next.seed !== null && next.seed !== undefined && capabilities.seed === false) {
    notes.push('This model does not accept a seed — it was dropped.');
    next.seed = null;
  }
  const maxN = Math.max(1, Number(capabilities.maxN) || 1);
  if (next.n > maxN) {
    notes.push(`This model generates at most ${maxN} image(s) per call — n reduced to ${maxN}.`);
    next.n = maxN;
  }
  return { canonical: next, notes };
}

const backendRegistry = new Map();

export function registerBackend(backend) {
  const kind = String(backend?.kind || '').trim();
  if (!kind) throw new Error('backend.kind is required');
  if (typeof backend.generate !== 'function') throw new Error(`backend ${kind} must implement generate()`);
  if (typeof backend.mapParams !== 'function') throw new Error(`backend ${kind} must implement mapParams()`);
  backendRegistry.set(kind, backend);
  return backend;
}

export function getBackend(kind) {
  return backendRegistry.get(String(kind || '').trim()) || null;
}

export function listBackendKinds() {
  return [...backendRegistry.keys()];
}

export default {
  IMAGE_ERROR,
  ImageBackendError,
  defaultCapabilities,
  resolveCapabilities,
  degradeCanonical,
  registerBackend,
  getBackend,
  listBackendKinds
};
