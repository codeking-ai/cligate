/**
 * Volcengine Ark image backend — covers 即梦 / Seedream (ByteDance).
 *
 * Ark's image API is OpenAI-shaped and SYNCHRONOUS:
 *   POST {baseUrl}/images/generations
 *   body: { model, prompt, size, response_format, watermark, seed, ... }
 *   resp: { data: [{ url } | { b64_json }] }
 * Default baseUrl is the Ark CN gateway; override per entry for other regions
 * or a compatible proxy. nativeModel is a Seedream model id (e.g.
 * "doubao-seedream-3-0-t2i-250415" or an "ep-..." endpoint id).
 */

import { IMAGE_ERROR, ImageBackendError, degradeCanonical, resolveCapabilities, imageErrorFromResponse } from '../backend.js';

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

// Seedream custom sizes use "WxH" within [1280x720, 4096x4096], aspect [1/16,16].
// Centered around the 2K default.
const SIZE_BY_RATIO = {
  '1:1': '2048x2048',
  '16:9': '2560x1440',
  '9:16': '1440x2560',
  '4:3': '2304x1728',
  '3:4': '1728x2304'
};

export const volcengineImagesBackend = {
  kind: 'volcengine-images',

  capabilities() {
    return {
      negativePrompt: false, // Ark image gen has no negative-prompt field
      seed: true,
      maxN: 4,
      qualities: ['draft', 'standard', 'high']
    };
  },

  mapParams(canonical = {}, entry = {}) {
    const caps = resolveCapabilities(this, entry);
    const { canonical: c, notes } = degradeCanonical(canonical, caps);
    const model = entry.nativeModel || 'doubao-seedream-3-0-t2i';

    const native = {
      model,
      prompt: c.prompt,
      size: SIZE_BY_RATIO[c.aspectRatio] || SIZE_BY_RATIO['1:1'],
      response_format: 'url',
      watermark: false,
      sequential_image_generation: 'disabled'
    };
    if (c.seed !== null && c.seed !== undefined) native.seed = c.seed;
    if (c.n > 1) native.n = c.n;

    // Tier-3 escape hatch: entry defaults then explicit providerParams win.
    Object.assign(native, entry.defaultParams || {}, c.providerParams || {});
    return { native, notes };
  },

  async generate({ native = {}, entry = {}, signal = undefined, fetchImpl = globalThis.fetch } = {}) {
    const apiKey = String(entry.apiKey || '').trim();
    if (!apiKey) {
      throw new ImageBackendError('model entry has no apiKey', { code: IMAGE_ERROR.AUTH, status: 401 });
    }
    const baseUrl = String(entry.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    const url = `${baseUrl}/images/generations`;

    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(native)
      });
    } catch (error) {
      throw new ImageBackendError(`network error: ${error?.message || error}`, { code: IMAGE_ERROR.UPSTREAM });
    }

    if (!response.ok) {
      throw await imageErrorFromResponse(response);
    }

    const body = await response.json();
    const data = Array.isArray(body?.data) ? body.data : [];
    if (data.length === 0) {
      throw new ImageBackendError('upstream returned no images', { code: IMAGE_ERROR.UPSTREAM });
    }
    const images = data.map((item) => ({
      base64: String(item?.b64_json || '').trim() || undefined,
      url: String(item?.url || '').trim() || undefined,
      mediaType: 'image/png'
    }));

    return { images, model: native.model, usage: body?.usage || null };
  }
};

export default volcengineImagesBackend;
