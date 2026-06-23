import imageGenModelStore from '../../image-gen/model-store.js';
import { ASPECT_RATIOS, QUALITIES } from '../../image-gen/canonical.js';

/**
 * generate_image — Tier-1 canonical, provider-agnostic image generation.
 *
 * The schema is deliberately small and stable: it never grows when new
 * providers/models are added. Provider-specific richness lives in each model
 * entry's defaultParams (configured on the Image Generation page) and is
 * mapped/degraded by the backend adapter. See
 * docs/assistant-image-generation-design.zh-CN.md.
 *
 * requiresApproval defaults to the image-gen setting (cloud generation costs
 * money, so it is gated by default) and is read at registry-build time — the
 * registry is rebuilt per run, so toggling the setting takes effect next run.
 */
export function createGenerateImageToolDefinition({ handlers, store = imageGenModelStore } = {}) {
  let requireApproval = true;
  try {
    requireApproval = store.getSettings().requireApproval !== false;
  } catch {
    requireApproval = true;
  }

  return {
    name: 'generate_image',
    description: 'Generate an image from a text prompt using a configured image-generation model. '
      + 'Returns the image as multimodal content and an artifactId you can pass to send_message_to_channel to deliver it to a chat.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw. Be specific about subject, style, composition.' },
        negativePrompt: { type: 'string', description: 'What to avoid (ignored by models that do not support it).' },
        aspectRatio: { type: 'string', enum: [...ASPECT_RATIOS], description: 'Image shape. Defaults to 1:1.' },
        n: { type: 'integer', minimum: 1, maximum: 4, description: 'Number of images (1–4; clamped by the model).' },
        quality: { type: 'string', enum: [...QUALITIES], description: 'draft | standard | high.' },
        seed: { type: 'integer', description: 'Optional seed for reproducibility (ignored if unsupported).' },
        model: { type: 'string', description: 'Optional model entry id; omit to use the default configured model.' }
      },
      required: ['prompt']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: requireApproval,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.generateImage
  };
}

export default createGenerateImageToolDefinition;
