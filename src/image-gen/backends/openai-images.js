/**
 * OpenAI-compatible image backend (first/only backend this phase).
 *
 * Talks to `POST {baseUrl}/images/generations`. Because `baseUrl` is overridable
 * per model entry, ANY OpenAI-compatible image vendor (gpt-image-1, DALL·E, and
 * compatible third parties) routes through this single adapter — adding such a
 * vendor is just a new model entry, no new code.
 *
 * Error strings mirror the chatgpt-responses executor convention so the service
 * can fold them onto runtime-state uniformly.
 */

import { IMAGE_ERROR, ImageBackendError, degradeCanonical, resolveCapabilities, imageErrorFromResponse } from '../backend.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function isDalle3(model) {
  return /^dall-e-3/i.test(String(model || ''));
}
function isDalle2(model) {
  return /^dall-e-2/i.test(String(model || ''));
}
function isGptImage(model) {
  return /^gpt-image/i.test(String(model || ''));
}

function orientation(aspectRatio) {
  if (aspectRatio === '1:1') return 'square';
  if (aspectRatio === '9:16' || aspectRatio === '3:4') return 'portrait';
  return 'landscape';
}

function mapSize(aspectRatio, model) {
  const o = orientation(aspectRatio);
  if (isDalle3(model)) {
    return { square: '1024x1024', landscape: '1792x1024', portrait: '1024x1792' }[o];
  }
  if (isDalle2(model)) {
    return '1024x1024'; // dall-e-2 only does squares
  }
  // gpt-image-1 and generic compatible vendors
  return { square: '1024x1024', landscape: '1536x1024', portrait: '1024x1536' }[o];
}

function mapQuality(quality, model) {
  if (isDalle3(model)) {
    return quality === 'high' ? 'hd' : 'standard';
  }
  if (isDalle2(model)) {
    return undefined; // dall-e-2 has no quality knob
  }
  // gpt-image-1 / generic
  return { draft: 'low', standard: 'medium', high: 'high' }[quality] || 'medium';
}

export const openAiImagesBackend = {
  kind: 'openai-images',

  capabilities(entry = {}) {
    const model = entry.nativeModel || '';
    return {
      negativePrompt: false, // OpenAI images API has no negative prompt field
      seed: false,
      maxN: isDalle3(model) ? 1 : 4, // dall-e-3 only returns 1 per request
      qualities: ['draft', 'standard', 'high']
    };
  },

  mapParams(canonical = {}, entry = {}) {
    const caps = resolveCapabilities(this, entry);
    const { canonical: c, notes } = degradeCanonical(canonical, caps);
    const model = entry.nativeModel || 'gpt-image-1';

    const native = {
      model,
      prompt: c.prompt,
      n: c.n,
      size: mapSize(c.aspectRatio, model)
    };
    const quality = mapQuality(c.quality, model);
    if (quality !== undefined) native.quality = quality;

    // gpt-image-1 returns b64_json and rejects response_format; DALL·E accepts it.
    if (!isGptImage(model)) {
      native.response_format = 'b64_json';
    }

    // Tier-3 escape hatch: per-entry defaults then explicit providerParams win.
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
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(native)
      });
    } catch (error) {
      // Network/transport failure — treat as retryable upstream error.
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

    return {
      images,
      model: native.model,
      usage: body?.usage || null
    };
  }
};

export default openAiImagesBackend;
