/**
 * Image-generation orchestration service.
 *
 * Ties the three tiers together: normalize canonical input → resolve a model
 * entry → pick its backend adapter → map/degrade params → call upstream →
 * persist each image to disk + an artifact record → estimate cost + bookkeep.
 *
 * Framework-agnostic on purpose: it returns plain data (`images` with base64 +
 * `artifacts` refs). The assistant tool handler assembles the multimodal
 * tool_result blocks; a future gateway route could reuse this same service.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { CONFIG_DIR } from '../account-manager.js';
import {
  getCredentialRuntimeState,
  markCredentialRateLimited,
  markCredentialError,
  markCredentialSuccess
} from '../runtime-state.js';
import artifactService from '../assistant-core/artifact-service.js';

import { normalizeCanonicalInput } from './canonical.js';
import { getBackend, registerBackend, IMAGE_ERROR } from './backend.js';
import { estimateImageCost } from './pricing.js';
import { imageGenModelStore } from './model-store.js';

// Register the built-in backends (imported for the registration side effect).
import { openAiImagesBackend } from './backends/openai-images.js';
import { volcengineImagesBackend } from './backends/volcengine-images.js';
import { wanxiangBackend } from './backends/wanxiang.js';
registerBackend(openAiImagesBackend);
registerBackend(volcengineImagesBackend);
registerBackend(wanxiangBackend);

const EXT_BY_MEDIA = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

function extFor(mediaType) {
  return EXT_BY_MEDIA[String(mediaType || '').toLowerCase()] || 'png';
}

export function imageArtifactsDir(configDir = CONFIG_DIR) {
  return join(configDir, 'artifacts');
}

class ImageGenError extends Error {
  constructor(message, { code = 'IMAGE_GEN_ERROR', recoverable = true } = {}) {
    super(message);
    this.name = 'ImageGenError';
    this.code = code;
    this.recoverable = recoverable;
  }
}

export class ImageGenService {
  constructor({
    store = imageGenModelStore,
    artifacts = artifactService,
    configDir = CONFIG_DIR,
    fetchImpl = (...args) => globalThis.fetch(...args)
  } = {}) {
    this.store = store;
    this.artifacts = artifacts;
    this.configDir = configDir;
    this.fetchImpl = fetchImpl;
  }

  /** Is at least one enabled model configured? Used by route/UI status. */
  isConfigured() {
    return Boolean(this.store.resolveModel(''));
  }

  async generate(input = {}, context = {}) {
    const settings = this.store.getSettings();
    const { canonical, notes } = normalizeCanonicalInput(input, {
      maxImagesPerCall: settings.maxImagesPerCall
    });

    const entry = this.store.resolveModel(canonical.model);
    if (!entry) {
      throw new ImageGenError(
        canonical.model
          ? `image model "${canonical.model}" not found`
          : 'no image-generation model is configured; add one on the Image Generation page first',
        { code: 'NO_MODEL' }
      );
    }
    if (entry.enabled === false) {
      throw new ImageGenError(`image model "${entry.displayName}" is disabled`, { code: 'MODEL_DISABLED' });
    }

    const backend = getBackend(entry.backendKind);
    if (!backend) {
      throw new ImageGenError(`no backend adapter for kind "${entry.backendKind}"`, { code: 'NO_BACKEND', recoverable: false });
    }

    // Honor an active cooldown so we don't hammer a rate-limited credential.
    const state = getCredentialRuntimeState(entry.id);
    if (state.status === 'cooldown' && state.rateLimitedUntil && state.rateLimitedUntil > Date.now()) {
      const waitMs = state.rateLimitedUntil - Date.now();
      throw new ImageGenError(`model "${entry.displayName}" is rate-limited; retry in ~${Math.ceil(waitMs / 1000)}s`, { code: 'RATE_LIMITED' });
    }

    const { native, notes: mapNotes } = backend.mapParams(canonical, entry);
    const allNotes = [...notes, ...mapNotes];

    let result;
    try {
      result = await backend.generate({ native, entry, signal: context.signal, fetchImpl: this.fetchImpl });
      markCredentialSuccess(entry.id, { model: native.model });
    } catch (error) {
      this.#recordFailure(entry.id, error, native.model);
      const message = String(error?.message || error || 'image generation failed');
      throw new ImageGenError(message, { code: error?.code || 'UPSTREAM_ERROR' });
    }

    const images = [];
    const artifacts = [];
    const dir = imageArtifactsDir(this.configDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

    for (const img of result.images) {
      const mediaType = img.mediaType || 'image/png';
      let buffer;
      if (img.base64) {
        buffer = Buffer.from(img.base64, 'base64');
      } else if (img.url) {
        buffer = await this.#downloadBytes(img.url);
      } else {
        continue;
      }
      const base64 = img.base64 || buffer.toString('base64');
      const artifactId = randomUUID();
      const filePath = join(dir, `imggen-${artifactId}.${extFor(mediaType)}`);
      writeFileSync(filePath, buffer, { mode: 0o600 });

      const artifact = this.artifacts.createArtifact({
        id: artifactId,
        kind: 'image',
        source: 'generate_image',
        role: 'assistant',
        mediaType,
        path: filePath,
        // Internal hosting route (not a data: URL — keeps artifacts.json small).
        imageUrl: `/api/artifacts/${artifactId}`,
        title: canonical.prompt.slice(0, 80),
        conversationId: context.conversationId || '',
        taskId: context.taskId || '',
        projectId: context.projectId || '',
        assistantRunId: context.assistantRunId || '',
        metadata: {
          backendKind: entry.backendKind,
          model: result.model,
          aspectRatio: canonical.aspectRatio,
          quality: canonical.quality
        }
      });

      images.push({ base64, mediaType });
      artifacts.push({
        artifactId: artifact.id,
        path: filePath,
        mediaType,
        downloadUrl: `/api/artifacts/${artifact.id}`
      });
    }

    if (images.length === 0) {
      throw new ImageGenError('backend returned images with no usable data', { code: 'EMPTY_RESULT' });
    }

    const cost = estimateImageCost({ entry, model: result.model, quality: canonical.quality, n: images.length });
    this.store.recordModelUsage(entry.id, { images: images.length, cost });

    return {
      modelId: entry.id,
      modelName: entry.displayName,
      backendKind: entry.backendKind,
      model: result.model,
      aspectRatio: canonical.aspectRatio,
      quality: canonical.quality,
      count: images.length,
      cost,
      notes: allNotes,
      images,
      artifacts
    };
  }

  #recordFailure(id, error, model) {
    this.store.recordModelError(id);
    if (error?.code === IMAGE_ERROR.RATE_LIMITED) {
      markCredentialRateLimited(id, error.retryAfterMs || 60_000, { message: error.message, model });
    } else if (error?.code === IMAGE_ERROR.AUTH) {
      markCredentialError(id, error, { invalid: true, model });
    } else {
      markCredentialError(id, error, { model });
    }
  }

  async #downloadBytes(url) {
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new ImageGenError(`failed to download generated image (${response.status})`, { code: 'DOWNLOAD_FAILED' });
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

export const imageGenService = new ImageGenService();

export { ImageGenError };
export default imageGenService;
