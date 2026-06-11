import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import agentChannelDeliverySender from '../../agent-channels/delivery-sender.js';
import agentChannelConversationStore from '../../agent-channels/conversation-store.js';
import artifactService from '../../assistant-core/artifact-service.js';
import { desktopScreenshotsDir } from '../../desktop-agent/paths.js';

// Channels whose provider can actually deliver an image today. delivery-sender
// passes `images` to every provider, but a provider without image support would
// silently ignore them — so we keep an explicit list here to report honest
// imageDelivered results to the supervisor instead of pretending an image went
// out. DingTalk (sampleImageMsg), Feishu (im/v1/images → msg_type:image), and
// Telegram (sendPhoto multipart) all upload the bytes themselves, so a local
// (localhost / file path) artifact is deliverable. Extend this when another
// provider gains real image support.
const IMAGE_CAPABLE_CHANNELS = new Set(['dingtalk', 'feishu', 'telegram']);

function inferImageMediaType(filePath) {
  const s = String(filePath || '').toLowerCase();
  if (s.endsWith('.png')) return 'image/png';
  if (s.endsWith('.jpg') || s.endsWith('.jpeg')) return 'image/jpeg';
  if (s.endsWith('.webp')) return 'image/webp';
  if (s.endsWith('.gif')) return 'image/gif';
  if (s.endsWith('.bmp')) return 'image/bmp';
  return 'image/png';
}

const SCREENSHOT_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

// The desktop agent writes screenshots under <desktopControlDir>/screenshots
// (resolved from CONFIG_DIR / DESKTOP_CONTROL_DIR — see desktop-agent/paths.js).
// We import the SAME resolver the manager passes to the Python agent so the Node
// reader and the Python writer never disagree on the directory.

// Heuristic gate: only attempt screenshot recovery for paths that were clearly
// meant to be a desktop screenshot, so an unrelated missing image path never
// silently turns into "send the latest screenshot".
function looksLikeScreenshotPath(p) {
  const normalized = String(p || '').toLowerCase().replace(/\\/g, '/');
  if (!normalized) return false;
  return normalized.includes('desktop-control')
    || normalized.includes('/screenshots/')
    || /^(?:screen-region-|screen-|inspect-window-|capture[_-])/i.test(path.basename(normalized));
}

// Recover a screenshot when the supervisor passes a path that doesn't exist.
// The LLM sometimes reconstructs an approximate screenshot path from memory
// (wrong directory and/or filename) instead of echoing the exact path
// desktop_capture_window returned — especially across an approval round-trip
// where the real path drops out of context. Prefer passing the capture's
// imageArtifactId instead, which avoids this entirely. Try an exact basename
// match in the canonical screenshots dir first (right file, wrong directory →
// not a substitution), then fall back to the most recently modified screenshot
// (in the capture→send flow that IS the just-captured one). Returns
// { path, exact } — path '' when nothing usable is found.
function recoverScreenshotPath(requestedPath) {
  const dir = desktopScreenshotsDir();
  let names;
  try {
    names = readdirSync(dir).filter((name) => SCREENSHOT_EXT_RE.test(name));
  } catch {
    return { path: '', exact: false };
  }
  if (names.length === 0) return { path: '', exact: false };

  const wantedBase = path.basename(String(requestedPath || '')).toLowerCase();
  if (wantedBase) {
    const exact = names.find((name) => name.toLowerCase() === wantedBase);
    if (exact) return { path: path.join(dir, exact), exact: true };
  }

  let newestPath = '';
  let newestMtime = -Infinity;
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const mtime = statSync(full).mtimeMs;
      if (mtime > newestMtime) {
        newestMtime = mtime;
        newestPath = full;
      }
    } catch {
      // unreadable entry — skip it
    }
  }
  return { path: newestPath, exact: false };
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
      let recoveredImageNote = '';
      if (imagePath) {
        let effectiveImagePath = imagePath;
        if (!existsSync(effectiveImagePath) && looksLikeScreenshotPath(effectiveImagePath)) {
          const recovered = recoverScreenshotPath(effectiveImagePath);
          if (recovered.path) {
            effectiveImagePath = recovered.path;
            // Exact basename match = the intended file (just a wrong directory),
            // so it is not a substitution and needs no note. A newest-fallback IS
            // a best-effort guess — surface a NEUTRAL note (not an error) and nudge
            // toward the stable handle so this stops happening.
            if (!recovered.exact) {
              recoveredImageNote = `Sent the current screenshot ("${path.basename(recovered.path)}"). Tip: pass desktop_capture_window's imageArtifactId to send_message_to_channel to forward the exact capture you mean.`;
            }
          }
        }
        images.push({ path: effectiveImagePath, mediaType: inferImageMediaType(effectiveImagePath), title: 'image' });
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
          : {}),
        ...(recoveredImageNote ? { note: recoveredImageNote } : {})
      };
    }
  };
}

export default createMessagingToolHandlers;
