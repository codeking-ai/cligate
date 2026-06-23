/**
 * Tier-1 canonical image-generation vocabulary.
 *
 * This is the SINGLE, provider-agnostic parameter surface the assistant tool
 * exposes to the LLM. It must stay small and stable: adding a new provider/model
 * never grows this set — provider-specific richness lives in a model entry's
 * `defaultParams` (Tier-3) and is mapped/degraded by each backend adapter (Tier-2).
 *
 * Keeping the canonical surface intentionally narrow is deliberate (see
 * docs/assistant-image-generation-design.zh-CN.md §2 "核心张力").
 */

export const ASPECT_RATIOS = Object.freeze(['1:1', '16:9', '9:16', '4:3', '3:4']);
export const QUALITIES = Object.freeze(['draft', 'standard', 'high']);

export const DEFAULT_ASPECT_RATIO = '1:1';
export const DEFAULT_QUALITY = 'standard';
export const MAX_N = 4;

function toText(value) {
  return String(value ?? '').trim();
}

function clampInt(value, { min, max, fallback }) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Map a canonical aspect ratio to concrete pixel dimensions for backends that
 * need width/height (e.g. ComfyUI / SD WebUI). `base` is the long edge target.
 * Returns dimensions rounded to a multiple of 64 (diffusion-friendly).
 */
export function aspectRatioToDimensions(aspectRatio = DEFAULT_ASPECT_RATIO, base = 1024) {
  const ratio = ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : DEFAULT_ASPECT_RATIO;
  const [w, h] = ratio.split(':').map((part) => Number.parseInt(part, 10));
  const round64 = (v) => Math.max(64, Math.round(v / 64) * 64);
  if (w >= h) {
    return { width: round64(base), height: round64((base * h) / w) };
  }
  return { width: round64((base * w) / h), height: round64(base) };
}

/**
 * Normalize raw tool input into a validated canonical request.
 *
 * Throws on a missing/empty prompt (the one hard requirement). Everything else
 * is coerced to a safe value rather than rejected, and any coercion that changed
 * the caller's intent is reported in `notes` so the supervisor sees it honestly.
 *
 * @returns {{ canonical: object, notes: string[] }}
 */
export function normalizeCanonicalInput(input = {}, { maxImagesPerCall = MAX_N } = {}) {
  const notes = [];
  const prompt = toText(input.prompt);
  if (!prompt) {
    const error = new Error('generate_image requires a non-empty "prompt".');
    error.code = 'INVALID_INPUT';
    throw error;
  }

  let aspectRatio = toText(input.aspectRatio) || DEFAULT_ASPECT_RATIO;
  if (!ASPECT_RATIOS.includes(aspectRatio)) {
    notes.push(`aspectRatio "${aspectRatio}" is not supported; using "${DEFAULT_ASPECT_RATIO}". Allowed: ${ASPECT_RATIOS.join(', ')}.`);
    aspectRatio = DEFAULT_ASPECT_RATIO;
  }

  let quality = toText(input.quality) || DEFAULT_QUALITY;
  if (!QUALITIES.includes(quality)) {
    notes.push(`quality "${quality}" is not supported; using "${DEFAULT_QUALITY}". Allowed: ${QUALITIES.join(', ')}.`);
    quality = DEFAULT_QUALITY;
  }

  const hardMax = Math.max(1, Math.min(MAX_N, Number(maxImagesPerCall) || MAX_N));
  const requestedN = input.n === undefined || input.n === null ? 1 : input.n;
  const n = clampInt(requestedN, { min: 1, max: hardMax, fallback: 1 });
  if (Number.isFinite(Number.parseInt(requestedN, 10)) && Number.parseInt(requestedN, 10) !== n) {
    notes.push(`n clamped to ${n} (allowed range 1–${hardMax}).`);
  }

  const negativePrompt = toText(input.negativePrompt);

  let seed = null;
  if (input.seed !== undefined && input.seed !== null && toText(input.seed) !== '') {
    const parsed = Number.parseInt(input.seed, 10);
    if (Number.isFinite(parsed)) seed = parsed;
  }

  const providerParams = (input.providerParams && typeof input.providerParams === 'object' && !Array.isArray(input.providerParams))
    ? { ...input.providerParams }
    : {};

  return {
    canonical: {
      prompt,
      negativePrompt,
      aspectRatio,
      quality,
      n,
      seed,
      model: toText(input.model),
      providerParams
    },
    notes
  };
}

export default {
  ASPECT_RATIOS,
  QUALITIES,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_QUALITY,
  MAX_N,
  aspectRatioToDimensions,
  normalizeCanonicalInput
};
