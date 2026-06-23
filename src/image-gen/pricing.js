/**
 * Per-image cost estimation.
 *
 * Image generation is billed per image (by model/size/quality), NOT per token,
 * so it deliberately does NOT go through the token-based usage-tracker — folding
 * it in would pollute text usage stats. Costs are accumulated on the model entry
 * (see model-store.js). A model entry may pin an explicit `pricing.perImage`,
 * which always wins over the built-in table below.
 */

// USD per image. Keep coarse — operators can override per entry.
const DEFAULT_TABLE = {
  'gpt-image-1': { low: 0.011, medium: 0.042, high: 0.167, _default: 0.042 },
  'dall-e-3': { standard: 0.04, hd: 0.08, _default: 0.04 },
  'dall-e-2': { _default: 0.02 }
};

function lookup(model, qualityHint) {
  const key = Object.keys(DEFAULT_TABLE).find((m) => String(model || '').toLowerCase().startsWith(m));
  if (!key) return 0;
  const row = DEFAULT_TABLE[key];
  return row[qualityHint] ?? row._default ?? 0;
}

/**
 * @param {object} args
 * @param {object} args.entry   model entry (may carry pricing.perImage)
 * @param {string} args.model   native model name
 * @param {string} args.quality canonical quality (draft|standard|high)
 * @param {number} args.n       image count
 * @returns {number} estimated USD cost
 */
export function estimateImageCost({ entry = {}, model = '', quality = 'standard', n = 1 } = {}) {
  const count = Math.max(1, Number(n) || 1);
  const perImage = Number(entry?.pricing?.perImage);
  if (Number.isFinite(perImage) && perImage >= 0) {
    return Number((perImage * count).toFixed(6));
  }
  // Map canonical quality onto the table's quality keys heuristically.
  const qualityHint = /^dall-e-3/i.test(model)
    ? (quality === 'high' ? 'hd' : 'standard')
    : ({ draft: 'low', standard: 'medium', high: 'high' }[quality] || quality);
  return Number((lookup(model, qualityHint) * count).toFixed(6));
}

export default { estimateImageCost };
