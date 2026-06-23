/**
 * DashScope 通义万相 (Tongyi Wanxiang) image backend — ASYNCHRONOUS.
 *
 * Unlike the OpenAI/Ark sync `/images/generations`, DashScope text-to-image is
 * a submit-then-poll flow:
 *   1) POST {baseUrl}/api/v1/services/aigc/text2image/image-synthesis
 *      header  X-DashScope-Async: enable
 *      body    { model, input:{ prompt, negative_prompt }, parameters:{ size, n, seed } }
 *      resp    { output:{ task_id, task_status } }
 *   2) GET  {baseUrl}/api/v1/tasks/{task_id}  → poll until
 *      output.task_status === 'SUCCEEDED' → output.results[].url
 *
 * This is exactly the case the Tier-2 backend abstraction exists for: the
 * canonical tool + UI are unchanged; only this adapter knows about the polling.
 */

import { IMAGE_ERROR, ImageBackendError, degradeCanonical, resolveCapabilities, imageErrorFromResponse } from '../backend.js';

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com';

// DashScope size is "W*H" (star-separated), each side in [512, 1440].
const SIZE_BY_RATIO = {
  '1:1': '1024*1024',
  '16:9': '1440*810',
  '9:16': '810*1440',
  '4:3': '1280*960',
  '3:4': '960*1280'
};

const TERMINAL_FAILURE = new Set(['FAILED', 'CANCELED', 'UNKNOWN']);

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ImageBackendError('aborted', { code: IMAGE_ERROR.UPSTREAM }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      reject(new ImageBackendError('aborted', { code: IMAGE_ERROR.UPSTREAM }));
    }, { once: true });
  });
}

export const wanxiangBackend = {
  kind: 'wanxiang',

  capabilities() {
    return {
      negativePrompt: true,
      seed: true,
      maxN: 4,
      qualities: ['draft', 'standard', 'high']
    };
  },

  mapParams(canonical = {}, entry = {}) {
    const caps = resolveCapabilities(this, entry);
    const { canonical: c, notes } = degradeCanonical(canonical, caps);
    const model = entry.nativeModel || 'wan2.2-t2i-flash';

    const native = {
      model,
      input: {
        prompt: c.prompt,
        ...(c.negativePrompt ? { negative_prompt: c.negativePrompt } : {})
      },
      parameters: {
        size: SIZE_BY_RATIO[c.aspectRatio] || SIZE_BY_RATIO['1:1'],
        n: c.n,
        watermark: false,
        ...(c.seed !== null && c.seed !== undefined ? { seed: c.seed } : {})
      }
    };
    // Tier-3 escape hatch: real DashScope params (e.g. prompt_extend) live in
    // entry.defaultParams; explicit providerParams win.
    Object.assign(native.parameters, entry.defaultParams || {}, c.providerParams || {});
    return { native, notes };
  },

  // pollIntervalMs / maxPollAttempts are generate options (not request params)
  // so they never leak into the DashScope body. Tests pass tiny values.
  async generate({ native = {}, entry = {}, signal = undefined, fetchImpl = globalThis.fetch, pollIntervalMs = 3000, maxPollAttempts = 60 } = {}) {
    const apiKey = String(entry.apiKey || '').trim();
    if (!apiKey) {
      throw new ImageBackendError('model entry has no apiKey', { code: IMAGE_ERROR.AUTH, status: 401 });
    }
    const baseUrl = String(entry.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    const submitUrl = `${baseUrl}/api/v1/services/aigc/text2image/image-synthesis`;

    let submit;
    try {
      submit = await fetchImpl(submitUrl, {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable'
        },
        body: JSON.stringify(native)
      });
    } catch (error) {
      throw new ImageBackendError(`network error: ${error?.message || error}`, { code: IMAGE_ERROR.UPSTREAM });
    }
    if (!submit.ok) {
      throw await imageErrorFromResponse(submit);
    }
    const submitBody = await submit.json();
    const taskId = String(submitBody?.output?.task_id || '').trim();
    if (!taskId) {
      throw new ImageBackendError('DashScope did not return a task_id', { code: IMAGE_ERROR.UPSTREAM });
    }

    const pollUrl = `${baseUrl}/api/v1/tasks/${taskId}`;
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      await delay(pollIntervalMs, signal);

      let poll;
      try {
        poll = await fetchImpl(pollUrl, { method: 'GET', signal, headers: { Authorization: `Bearer ${apiKey}` } });
      } catch (error) {
        throw new ImageBackendError(`network error while polling: ${error?.message || error}`, { code: IMAGE_ERROR.UPSTREAM });
      }
      if (!poll.ok) {
        throw await imageErrorFromResponse(poll);
      }
      const pollBody = await poll.json();
      const status = String(pollBody?.output?.task_status || '').toUpperCase();

      if (status === 'SUCCEEDED') {
        const results = Array.isArray(pollBody?.output?.results) ? pollBody.output.results : [];
        const images = results
          .filter((r) => r?.url)
          .map((r) => ({ url: String(r.url).trim(), mediaType: 'image/png' }));
        if (images.length === 0) {
          throw new ImageBackendError('DashScope task succeeded but returned no images', { code: IMAGE_ERROR.UPSTREAM });
        }
        return { images, model: native.model, usage: pollBody?.usage || null };
      }
      if (TERMINAL_FAILURE.has(status)) {
        const reason = pollBody?.output?.message || pollBody?.output?.code || status;
        throw new ImageBackendError(`DashScope task ${status}: ${reason}`, { code: IMAGE_ERROR.UPSTREAM });
      }
      // PENDING / RUNNING → keep polling
    }

    throw new ImageBackendError(`DashScope task timed out after ${maxPollAttempts} polls`, { code: IMAGE_ERROR.UPSTREAM });
  }
};

export default wanxiangBackend;
