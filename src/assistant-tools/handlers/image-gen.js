import imageGenService, { ImageGenError } from '../../image-gen/service.js';

/**
 * generate_image handler.
 *
 * Returns an Anthropic-canonical image block array under `content` so the
 * supervisor request stays one shape across providers — the SAME contract
 * view_image relies on (react-engine.appendToolResultMessage forwards
 * payload.content blocks to the model). The remaining structured fields
 * (artifactId/path/downloadUrl) stay visible as a JSON text block so the model
 * can forward the image with send_message_to_channel (pass imageArtifactId).
 */
export function createImageGenToolHandlers({ service = imageGenService } = {}) {
  return {
    async generateImage({ input = {}, context = {} } = {}) {
      const generationContext = {
        conversationId: context.conversation?.id || context.run?.conversationId || '',
        taskId: context.run?.taskId || '',
        projectId: context.run?.projectId || '',
        assistantRunId: context.run?.id || '',
        signal: context.signal
      };

      try {
        const result = await service.generate(input, generationContext);
        const content = result.images.map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.base64 }
        }));
        return {
          kind: 'image_generation_result',
          model: result.model,
          modelName: result.modelName,
          aspectRatio: result.aspectRatio,
          quality: result.quality,
          count: result.count,
          cost: result.cost,
          artifactId: result.artifacts[0]?.artifactId || '',
          artifacts: result.artifacts.map((a) => ({
            artifactId: a.artifactId,
            path: a.path,
            downloadUrl: a.downloadUrl,
            mediaType: a.mediaType
          })),
          ...(result.notes?.length ? { notes: result.notes } : {}),
          content
        };
      } catch (error) {
        if (error instanceof ImageGenError) {
          // Recoverable: hand a clear, actionable message back to the model
          // (e.g. "no model configured", "rate-limited") instead of crashing
          // the tool — mirrors the messaging handler's recoverable-error style.
          return {
            kind: 'image_generation_failed',
            error: error.message,
            code: error.code,
            recoverable: error.recoverable !== false
          };
        }
        throw error;
      }
    }
  };
}

export default createImageGenToolHandlers;
