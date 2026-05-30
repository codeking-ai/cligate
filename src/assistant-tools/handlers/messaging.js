import agentChannelDeliverySender from '../../agent-channels/delivery-sender.js';
import agentChannelConversationStore from '../../agent-channels/conversation-store.js';
import artifactService from '../../assistant-core/artifact-service.js';

// Channels whose provider can actually deliver an image today. delivery-sender
// passes `images` to every provider, but providers without image support
// silently ignore them — so we keep an explicit list here to report honest
// imageDelivered results to the supervisor instead of pretending an image went
// out. Extend this when a provider gains real image support.
const IMAGE_CAPABLE_CHANNELS = new Set(['dingtalk']);

function inferImageMediaType(filePath) {
  const s = String(filePath || '').toLowerCase();
  if (s.endsWith('.png')) return 'image/png';
  if (s.endsWith('.jpg') || s.endsWith('.jpeg')) return 'image/jpeg';
  if (s.endsWith('.webp')) return 'image/webp';
  if (s.endsWith('.gif')) return 'image/gif';
  if (s.endsWith('.bmp')) return 'image/bmp';
  return 'image/png';
}

export function createMessagingToolHandlers({
  deliverySender = agentChannelDeliverySender,
  conversationStore = agentChannelConversationStore,
  artifactServiceInstance = artifactService
} = {}) {
  return {
    async sendMessageToChannel({ input = {}, context = {} } = {}) {
      const text = String(input.text || '').trim();
      const imagePath = String(input.imagePath || '').trim();
      const imageArtifactId = String(input.imageArtifactId || '').trim();
      if (!text && !imagePath && !imageArtifactId) {
        return {
          kind: 'invalid_input',
          error: 'send_message_to_channel needs at least one of: text, imagePath, imageArtifactId.',
          recoverable: true
        };
      }

      // Resolve the target conversation. Default to the originating conversation
      // (the channel the user is talking to you on). An explicit
      // targetConversationId must resolve to a real conversation — never send to
      // an arbitrary/unknown id.
      const originating = context.conversation || null;
      const originatingId = String(originating?.id || '').trim();
      const targetId = String(input.targetConversationId || '').trim() || originatingId;
      if (!targetId) {
        return { kind: 'no_conversation', error: 'no target conversation in context; cannot send.', recoverable: true };
      }
      const conversation = conversationStore.get?.(targetId)
        || (targetId === originatingId ? originating : null);
      if (!conversation?.id) {
        return { kind: 'conversation_not_found', error: `target conversation ${targetId} not found`, recoverable: true };
      }

      const channel = String(conversation.channel || '').trim();
      const imageSupported = IMAGE_CAPABLE_CHANNELS.has(channel);

      // Build the outbound image. A local file path is preferred (no base64
      // bloat — the provider uploads the file). desktop_capture_window returns
      // exactly such a path in its `path` field.
      const images = [];
      if (imagePath) {
        images.push({ path: imagePath, mediaType: inferImageMediaType(imagePath), title: 'image' });
      } else if (imageArtifactId) {
        const artifact = artifactServiceInstance.getArtifact?.(imageArtifactId) || null;
        if (!artifact) {
          return { kind: 'artifact_not_found', error: `image artifact ${imageArtifactId} not found`, recoverable: true };
        }
        images.push({
          imageUrl: String(artifact.imageUrl || '').trim(),
          path: String(artifact.path || '').trim(),
          mediaType: String(artifact.mediaType || '').trim(),
          title: String(artifact.title || 'image').trim(),
          artifactId: String(artifact.id || '').trim()
        });
      }
      const wantsImage = images.length > 0;

      // Image requested but the channel cannot deliver images and there is no
      // text to fall back to — don't send an empty message; tell the supervisor.
      if (wantsImage && !imageSupported && !text) {
        return {
          kind: 'channel_send_skipped',
          delivered: false,
          channel,
          conversationId: conversation.id,
          imageRequested: true,
          imageSupported: false,
          imageDelivered: false,
          note: `channel "${channel}" cannot send images and no text was provided; nothing sent. Image-capable channels: ${[...IMAGE_CAPABLE_CHANNELS].join(', ')}.`,
          recoverable: true
        };
      }

      const effectiveImages = (wantsImage && imageSupported) ? images : [];

      let result = null;
      let sendError = null;
      try {
        result = await deliverySender.send({
          conversation,
          channel,
          payload: { sourceType: 'assistant_send_tool' },
          message: { text, images: effectiveImages }
        });
      } catch (error) {
        sendError = String(error?.message || error || 'send failed');
      }

      // delivery-sender returns null when there is no provider for the channel,
      // or when there is genuinely nothing to send.
      const delivered = !sendError && result !== null;

      return {
        kind: 'channel_send_result',
        delivered,
        channel,
        conversationId: conversation.id,
        textSent: Boolean(text) && delivered,
        imageRequested: wantsImage,
        imageSupported: wantsImage ? imageSupported : null,
        imageDelivered: wantsImage ? (delivered && imageSupported) : false,
        messageId: String(result?.messageId || ''),
        ...(sendError ? { error: sendError, recoverable: true } : {}),
        ...(!delivered && !sendError
          ? { error: `no delivery provider for channel "${channel}" (it may not support outbound sends).`, recoverable: true }
          : {}),
        ...(wantsImage && !imageSupported && text
          ? { note: `channel "${channel}" does not support images yet — only the text was delivered. Image-capable channels: ${[...IMAGE_CAPABLE_CHANNELS].join(', ')}.` }
          : {})
      };
    }
  };
}

export default createMessagingToolHandlers;
