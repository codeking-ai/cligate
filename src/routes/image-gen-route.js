/**
 * Image-generation management API (/api/image-gen/*).
 *
 * Independent of the chat API-key pool by design — image models have their own
 * store, params and per-image billing. Thin layer over src/image-gen/.
 */

import { imageGenModelStore } from '../image-gen/model-store.js';
import imageGenService from '../image-gen/service.js';
import { listBackendKinds } from '../image-gen/backend.js';
import { logger } from '../utils/logger.js';

function statusPayload() {
  return {
    settings: imageGenModelStore.getSettings(),
    models: imageGenModelStore.listModels(),
    backendKinds: listBackendKinds(),
    configured: imageGenService.isConfigured()
  };
}

export function handleGetImageGenStatus(req, res) {
  res.json({ success: true, ...statusPayload() });
}

export function handleListImageGenModels(req, res) {
  res.json({ success: true, models: imageGenModelStore.listModels() });
}

export function handleAddImageGenModel(req, res) {
  const body = req.body || {};
  if (!String(body.displayName || '').trim() && !String(body.nativeModel || '').trim()) {
    return res.status(400).json({ success: false, error: 'displayName or nativeModel is required' });
  }
  const model = imageGenModelStore.addModel(body);
  res.status(201).json({ success: true, model, ...statusPayload() });
}

export function handleUpdateImageGenModel(req, res) {
  const model = imageGenModelStore.updateModel(req.params.id, req.body || {});
  if (!model) return res.status(404).json({ success: false, error: 'model not found' });
  res.json({ success: true, model, ...statusPayload() });
}

export function handleRemoveImageGenModel(req, res) {
  const removed = imageGenModelStore.removeModel(req.params.id);
  if (!removed) return res.status(404).json({ success: false, error: 'model not found' });
  res.json({ success: true, ...statusPayload() });
}

export function handleSetImageGenModelEnabled(req, res) {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
  }
  const model = imageGenModelStore.updateModel(req.params.id, { enabled });
  if (!model) return res.status(404).json({ success: false, error: 'model not found' });
  res.json({ success: true, model, ...statusPayload() });
}

export function handleGetImageGenSettings(req, res) {
  res.json({ success: true, settings: imageGenModelStore.getSettings() });
}

export function handleUpdateImageGenSettings(req, res) {
  const settings = imageGenModelStore.setSettings(req.body || {});
  res.json({ success: true, settings, ...statusPayload() });
}

/**
 * Manual generation from the dashboard (test / playground). Returns download
 * URLs rather than inline base64 to keep the response light — the UI renders
 * <img src="/api/artifacts/:id">.
 */
export async function handleGenerateImage(req, res) {
  try {
    const result = await imageGenService.generate(req.body || {}, {});
    res.json({
      success: true,
      model: result.model,
      modelName: result.modelName,
      aspectRatio: result.aspectRatio,
      quality: result.quality,
      count: result.count,
      cost: result.cost,
      notes: result.notes,
      images: result.artifacts.map((a) => ({ artifactId: a.artifactId, url: a.downloadUrl, mediaType: a.mediaType }))
    });
  } catch (error) {
    const code = error?.code || 'ERROR';
    const httpStatus = (code === 'NO_MODEL' || code === 'INVALID_INPUT' || code === 'MODEL_DISABLED') ? 400 : 502;
    logger.warn?.(`[ImageGen] manual generate failed: ${error?.message || error}`);
    res.status(httpStatus).json({ success: false, error: String(error?.message || error), code });
  }
}

export default {
  handleGetImageGenStatus,
  handleListImageGenModels,
  handleAddImageGenModel,
  handleUpdateImageGenModel,
  handleRemoveImageGenModel,
  handleSetImageGenModelEnabled,
  handleGetImageGenSettings,
  handleUpdateImageGenSettings,
  handleGenerateImage
};
