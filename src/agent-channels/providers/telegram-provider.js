import crypto from 'crypto';
import { readFileSync } from 'fs';

import { createNormalizedChannelMessage } from '../models.js';

const TELEGRAM_SAFE_MESSAGE_LIMIT = 3500;
const TELEGRAM_CAPTION_LIMIT = 1024;

function normalizeOutboundImageCandidates(images = []) {
  if (!Array.isArray(images)) {
    return [];
  }
  return images
    .filter((image) => image && typeof image === 'object')
    .map((image) => ({
      imageUrl: String(
        image.imageUrl
        || image.image_url
        || image.photoURL
        || image.photoUrl
        || image.url
        || ''
      ).trim(),
      mediaType: String(image.mediaType || image.media_type || '').trim(),
      title: String(image.title || '').trim(),
      path: String(image.path || image.localPath || image.local_path || '').trim()
    }))
    .filter((image) => image.imageUrl || image.path);
}

function isDataUrl(value = '') {
  return /^data:/i.test(String(value || '').trim());
}

function isHttpUrl(value = '') {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function inferMediaTypeFromRef(ref = '') {
  const normalized = String(ref || '').trim().toLowerCase();
  if (normalized.includes('.png')) return 'image/png';
  if (normalized.includes('.webp')) return 'image/webp';
  if (normalized.includes('.gif')) return 'image/gif';
  if (normalized.includes('.bmp')) return 'image/bmp';
  return 'image/jpeg';
}

function inferExtension(mediaType = '') {
  const normalized = String(mediaType || '').trim().toLowerCase();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/bmp') return 'bmp';
  return 'jpg';
}

// Authoritative image MIME from the leading magic bytes. Telegram's file CDN
// (and Feishu's resource API) often serves images as application/octet-stream,
// which vision models reject — so we never trust the response content-type for
// the data URL; we sniff the bytes and fall back to an image/* type.
function sniffImageMediaType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return '';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  if (buffer.length >= 12
    && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
  return '';
}

function isImageMimeType(value = '') {
  return /^image\/[a-z0-9.+-]+$/i.test(String(value || '').trim());
}

function decodeDataUrl(dataUrl = '', mediaTypeHint = '') {
  const trimmed = String(dataUrl || '').trim();
  const match = trimmed.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) {
    throw new Error('invalid data url for telegram image upload');
  }
  const mediaType = String(mediaTypeHint || match[1] || 'image/jpeg').trim() || 'image/jpeg';
  return {
    buffer: Buffer.from(match[2], 'base64'),
    mediaType,
    fileName: `cligate-image.${inferExtension(mediaType)}`
  };
}

function buildMultipartFormData({ boundary = '', fields = [], file = null } = {}) {
  const chunks = [];
  for (const field of fields) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${String(field?.name || '')}"\r\n\r\n`
      + `${String(field?.value ?? '')}\r\n`,
      'utf8'
    ));
  }
  if (file?.buffer) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${String(file.field || 'file')}"; filename="${String(file.fileName || 'image.jpg')}"\r\n`
      + `Content-Type: ${String(file.mediaType || 'application/octet-stream')}\r\n\r\n`,
      'utf8'
    ));
    chunks.push(Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function isImageDocument(document) {
  return Boolean(document && /^image\//i.test(String(document.mime_type || '')));
}

// Telegram delivers a photo as `message.photo` — an array of PhotoSize ascending
// by resolution — so the last entry is the largest. An image sent "as a file"
// arrives as `message.document` with an image/* mime type instead.
function pickTelegramImageFileId(message = {}) {
  if (Array.isArray(message?.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return String(largest?.file_id || '').trim();
  }
  if (isImageDocument(message?.document)) {
    return String(message.document.file_id || '').trim();
  }
  return '';
}

function buildDisplayName(from = {}) {
  return from.username || [from.first_name, from.last_name].filter(Boolean).join(' ') || String(from.id || '');
}

function mapCallbackDataToText(data) {
  const raw = String(data || '');
  if (raw.startsWith('cligate:approve')) {
    return '/approve';
  }
  if (raw.startsWith('cligate:deny')) {
    return '/deny';
  }
  return raw;
}

function providerLabel(providerId) {
  if (providerId === 'claude-code') return 'Claude Code';
  if (providerId === 'codex') return 'Codex';
  return String(providerId || 'agent');
}

function buildRouterResultText(result) {
  switch (result?.type) {
    case 'pairing_required':
      return `Pairing required. Code: ${result?.pairing?.code || ''}`.trim();
    case 'command_error':
      return result.message || 'Command error';
    case 'runtime_started':
      if (result?.message) {
        return `${result.message}\nSession ${result?.session?.id || ''} started with ${providerLabel(result?.session?.provider || result?.provider)}.`.trim();
      }
      if (result?.startedFresh && result?.replacedSessionId) {
        return `Started a fresh task with ${providerLabel(result?.session?.provider || result?.provider)}. Previous session ${result.replacedSessionId} was detached. New session: ${result?.session?.id || ''}`.trim();
      }
      return `Task accepted. Session ${result?.session?.id || ''} started with ${providerLabel(result?.session?.provider || result?.provider)}.`.trim();
    case 'runtime_continued':
      if (result?.message) {
        return `${result.message}\nSent follow-up to session ${result?.session?.id || ''}.`.trim();
      }
      return `Sent follow-up to session ${result?.session?.id || ''}.`.trim();
    case 'runtime_cancelled':
      return `Session ${result?.session?.id || ''} cancelled.`.trim();
    case 'conversation_reset':
      return result?.message || 'Runtime session detached.';
    case 'runtime_status':
      return `Session ${result?.session?.id || ''}: ${result?.session?.status || 'unknown'}${result?.session?.summary ? `\n${result.session.summary}` : ''}`.trim();
    case 'supervisor_status':
      return result?.message || 'No supervisor status available.';
    case 'approval_resolved':
      return result?.message || `Approval ${result?.approval?.status || 'resolved'}.`;
    case 'question_answered':
      return 'Answer sent to the active task.';
    case 'preference_saved':
      return result?.message || 'Preference saved.';
    case 'assistant_mode_entered':
    case 'assistant_mode_exited':
    case 'assistant_run_accepted':
    case 'assistant_response':
      return result?.message || '';
    default:
      return '';
  }
}

function buildRouterFailureText(error) {
  const message = String(error?.message || '').trim() || 'Unknown error';
  return `Task failed before the runtime session could be established.\n${message}`;
}

function splitTelegramText(text, maxLength = TELEGRAM_SAFE_MESSAGE_LIMIT) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!source) {
    return [''];
  }

  if (source.length <= maxLength) {
    return [source];
  }

  const chunks = [];
  let remaining = source;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }

    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  if (chunks.length <= 1) {
    return chunks;
  }

  return chunks.map((chunk, index) => {
    const prefix = `[${index + 1}/${chunks.length}] `;
    return `${prefix}${chunk}`;
  });
}

export class TelegramChannelProvider {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.id = 'telegram';
    this.label = 'Telegram';
    this.fetchImpl = fetchImpl;
    this.capabilities = {
      mode: 'polling',
      supportedModes: ['polling'],
      supportsWebhook: true,
      supportsPolling: true,
      supportsInteractiveApproval: true,
      supportsRichCard: false,
      supportsThreading: false,
      supportsEditMessage: true
    };
    this.configFields = [
      { key: 'enabled', type: 'boolean', labelKey: 'channelEnabled', section: 'basic' },
      { key: 'mode', type: 'select', labelKey: 'channelMode', section: 'basic', options: [{ value: 'polling', labelKey: 'channelModePolling' }] },
      { key: 'botToken', type: 'password', labelKey: 'channelBotToken', placeholderKey: 'channelBotTokenPlaceholder', section: 'auth' },
      { key: 'pollingIntervalMs', type: 'number', labelKey: 'channelPollInterval', section: 'transport' },
      { key: 'defaultRuntimeProvider', type: 'runtime-provider', labelKey: 'channelDefaultRuntime', section: 'runtime' },
      { key: 'cwd', type: 'text', labelKey: 'channelWorkingDirectory', section: 'runtime' },
      { key: 'requirePairing', type: 'boolean', labelKey: 'channelRequirePairing', section: 'security' }
    ];
    this.running = false;
    this.timer = null;
    this.pollInFlight = false;
    this.offset = 0;
    this.router = null;
    this.settings = null;
    this.logger = console;
  }

  getStatus() {
    return {
      running: this.running,
      mode: this.settings?.mode || this.capabilities.mode,
      offset: this.offset
    };
  }

  async start({ settings, router, logger } = {}) {
    this.settings = settings || {};
    this.router = router || null;
    this.logger = logger || console;

    if (!this.fetchImpl) {
      return { started: false, reason: 'fetch is unavailable' };
    }
    if (!this.settings?.botToken) {
      return { started: false, reason: 'telegram botToken is not configured' };
    }
    if ((this.settings.mode || 'polling') !== 'polling') {
      return { started: false, reason: `unsupported telegram mode: ${this.settings.mode}` };
    }

    this.running = true;
    this._scheduleNextPoll(0);
    return { started: true };
  }

  async stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return { stopped: true };
  }

  async callApi(method, payload = {}) {
    if (!this.settings?.botToken) {
      throw new Error('telegram botToken is not configured');
    }
    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.settings.botToken}/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );

    const data = await response.json();
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.description || `Telegram API ${method} failed`);
    }
    return data.result;
  }

  async callApiMultipart(method, { fields = [], file = null } = {}) {
    if (!this.settings?.botToken) {
      throw new Error('telegram botToken is not configured');
    }
    const boundary = `----cligate-${crypto.randomBytes(8).toString('hex')}`;
    const body = buildMultipartFormData({ boundary, fields, file });
    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.settings.botToken}/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body
      }
    );

    const data = await response.json();
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.description || `Telegram API ${method} failed`);
    }
    return data.result;
  }

  // Resolve an outbound image into raw bytes locally. Telegram's servers fetch
  // any URL we pass to sendPhoto, so a localhost artifact URL is unreachable to
  // them — we must read/download the bytes ourselves and upload via multipart.
  async resolveImageBytes(image = {}) {
    const path = String(image?.path || '').trim();
    if (path) {
      const mediaType = String(image?.mediaType || inferMediaTypeFromRef(path)).trim() || 'image/jpeg';
      return {
        buffer: readFileSync(path),
        mediaType,
        fileName: path.split(/[\\/]/).pop() || `cligate-image.${inferExtension(mediaType)}`
      };
    }

    const imageUrl = String(image?.imageUrl || '').trim();
    if (isDataUrl(imageUrl)) {
      return decodeDataUrl(imageUrl, image?.mediaType || '');
    }
    if (isHttpUrl(imageUrl)) {
      const response = await this.fetchImpl(imageUrl);
      if (!response || response.ok === false) {
        throw new Error(`failed to download telegram image: ${imageUrl}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const mediaType = String(
        image?.mediaType
        || response.headers?.get?.('content-type')
        || inferMediaTypeFromRef(imageUrl)
      ).trim() || 'image/jpeg';
      return {
        buffer,
        mediaType,
        fileName: `cligate-image.${inferExtension(mediaType)}`
      };
    }

    throw new Error('telegram image delivery requires a readable local path, a data URL, or an http(s) image url');
  }

  async sendOnePhoto({ conversation, image }) {
    const file = await this.resolveImageBytes(image);
    const caption = String(image?.title || '').trim();
    const fields = [{ name: 'chat_id', value: String(conversation?.externalConversationId || '') }];
    if (caption && caption.length <= TELEGRAM_CAPTION_LIMIT) {
      fields.push({ name: 'caption', value: caption });
    }
    return this.callApiMultipart('sendPhoto', {
      fields,
      file: {
        field: 'photo',
        buffer: file.buffer,
        fileName: file.fileName,
        mediaType: file.mediaType
      }
    });
  }

  _scheduleNextPoll(delayMs = null) {
    if (!this.running) {
      return;
    }
    const waitMs = Number.isFinite(Number(delayMs))
      ? Number(delayMs)
      : Number(this.settings?.pollingIntervalMs || 2000);
    this.timer = setTimeout(() => {
      this.pollOnce().catch((error) => {
        this.logger?.warn?.(`[TelegramChannel] Poll failed: ${error.message}`);
      });
    }, Math.max(0, waitMs));
  }

  normalizeInbound(update) {
    if (update?.message?.text) {
      const message = update.message;
      return createNormalizedChannelMessage({
        channel: 'telegram',
        accountId: this.instanceId || 'default',
        deliveryMode: 'polling',
        externalMessageId: String(message.message_id || ''),
        externalConversationId: String(message.chat?.id || ''),
        externalUserId: String(message.from?.id || ''),
        externalUserName: buildDisplayName(message.from),
        text: String(message.text || ''),
        messageType: 'text',
        raw: update
      });
    }

    const imageFileId = pickTelegramImageFileId(update?.message);
    if (imageFileId) {
      const message = update.message;
      return createNormalizedChannelMessage({
        channel: 'telegram',
        accountId: this.instanceId || 'default',
        deliveryMode: 'polling',
        externalMessageId: String(message.message_id || ''),
        externalConversationId: String(message.chat?.id || ''),
        externalUserId: String(message.from?.id || ''),
        externalUserName: buildDisplayName(message.from),
        text: String(message.caption || ''),
        messageType: 'photo',
        metadata: { fileId: imageFileId },
        raw: update
      });
    }

    if (update?.callback_query?.data) {
      const callback = update.callback_query;
      return createNormalizedChannelMessage({
        channel: 'telegram',
        accountId: this.instanceId || 'default',
        deliveryMode: 'polling',
        externalMessageId: String(callback.id || ''),
        externalConversationId: String(callback.message?.chat?.id || ''),
        externalUserId: String(callback.from?.id || ''),
        externalUserName: buildDisplayName(callback.from),
        text: mapCallbackDataToText(callback.data),
        messageType: 'action',
        action: {
          type: 'callback_query',
          callbackQueryId: String(callback.id || ''),
          data: String(callback.data || '')
        },
        raw: update
      });
    }

    return null;
  }

  // Download an inbound Telegram image and turn it into assistant inputParts.
  // We fetch the bytes ourselves (getFile -> file download) and embed them as a
  // base64 data URL rather than handing the model the file URL: the Telegram
  // file URL carries the bot token, and a data URL keeps delivery fully local
  // (no upstream URL fetch required).
  async buildInboundImageParts(inbound = {}) {
    const fileId = String(inbound?.metadata?.fileId || '').trim();
    if (!fileId) {
      return [];
    }
    const fileInfo = await this.callApi('getFile', { file_id: fileId });
    const filePath = String(fileInfo?.file_path || '').trim();
    if (!filePath) {
      throw new Error('telegram getFile returned no file_path');
    }
    const downloadUrl = `https://api.telegram.org/file/bot${this.settings.botToken}/${filePath}`;
    const response = await this.fetchImpl(downloadUrl);
    if (!response || response.ok === false) {
      throw new Error('failed to download telegram inbound image');
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const headerType = String(response.headers?.get?.('content-type') || '').trim().toLowerCase();
    const mediaType = sniffImageMediaType(buffer)
      || (isImageMimeType(headerType) ? headerType : '')
      || inferMediaTypeFromRef(filePath)
      || 'image/jpeg';
    const dataUrl = `data:${mediaType};base64,${buffer.toString('base64')}`;

    const parts = [{ type: 'input_image', image_url: dataUrl, media_type: mediaType }];
    const caption = String(inbound?.text || '').trim();
    if (caption) {
      parts.unshift({ type: 'text', text: caption });
    }
    return parts;
  }

  // Enrich a normalized photo message with downloaded image inputParts so the
  // assistant can actually see it. On download failure we still route a text
  // placeholder so the sender is never silently ignored.
  async resolveInboundImage(inbound) {
    if (inbound?.messageType !== 'photo') {
      return inbound;
    }
    try {
      const inputParts = await this.buildInboundImageParts(inbound);
      return createNormalizedChannelMessage({
        ...inbound,
        text: inbound.text || '[Telegram image]',
        inputParts
      });
    } catch (error) {
      this.logger?.warn?.(`[TelegramChannel] Failed to fetch inbound image: ${error.message}`);
      return createNormalizedChannelMessage({
        ...inbound,
        text: inbound.text || '[Telegram image — failed to download]'
      });
    }
  }

  async pollOnce() {
    if (!this.running || this.pollInFlight) {
      return 0;
    }

    this.pollInFlight = true;
    try {
      const updates = await this.callApi('getUpdates', {
        offset: this.offset > 0 ? this.offset : undefined,
        timeout: 0,
        allowed_updates: ['message', 'callback_query']
      });

      let processed = 0;
      for (const update of updates || []) {
        if (Number.isFinite(Number(update?.update_id))) {
          this.offset = Number(update.update_id) + 1;
        }

        const normalized = this.normalizeInbound(update);
        if (!normalized) {
          continue;
        }
        const inbound = await this.resolveInboundImage(normalized);

        try {
          const result = await this.router.routeInboundMessage(inbound, {
            defaultRuntimeProvider: this.settings?.defaultRuntimeProvider || 'codex',
            requirePairing: this.settings?.requirePairing === true,
            cwd: this.settings?.cwd || ''
          });

          await this.handleRouterResult(inbound, result);
        } catch (error) {
          await this.sendMessage({
            conversation: {
              externalConversationId: inbound.externalConversationId
            },
            text: buildRouterFailureText(error)
          });
        }
        if (inbound.action?.type === 'callback_query') {
          await this.answerCallback({
            callbackQueryId: inbound.action.callbackQueryId,
            text: 'Processed'
          });
        }
        processed += 1;
      }

      return processed;
    } finally {
      this.pollInFlight = false;
      if (this.running) {
        this._scheduleNextPoll();
      }
    }
  }

  async handleRouterResult(inbound, result) {
    const text = buildRouterResultText(result);
    if (!text || result?.type === 'duplicate') {
      return null;
    }

    return this.sendMessage({
      conversation: {
        externalConversationId: inbound.externalConversationId
      },
      text
    });
  }

  async sendMessage({ conversation, text, buttons = [], images = [] } = {}) {
    const normalizedImages = normalizeOutboundImageCandidates(images);
    const hasText = Boolean(String(text || '').trim());
    let result = null;

    // Preserve the original text path verbatim. Only skip it when this is an
    // image-only delivery (no text), so we don't emit an empty message.
    if (hasText || normalizedImages.length === 0) {
      const textChunks = splitTelegramText(text);
      for (let index = 0; index < textChunks.length; index += 1) {
        const payload = {
          chat_id: conversation?.externalConversationId,
          text: textChunks[index]
        };

        if (buttons.length > 0 && index === textChunks.length - 1) {
          payload.reply_markup = {
            inline_keyboard: [
              buttons.map((button) => ({
                text: button.text,
                callback_data: `cligate:${button.action || button.id || 'action'}:${button.approvalId || ''}`
              }))
            ]
          };
        }

        result = await this.callApi('sendMessage', payload);
      }
    }

    if (normalizedImages.length > 0) {
      let sent = 0;
      let lastError = null;
      for (const image of normalizedImages) {
        try {
          result = await this.sendOnePhoto({ conversation, image });
          sent += 1;
        } catch (error) {
          lastError = error;
          this.logger?.warn?.(`[TelegramChannel] Skipping unsupported outbound image: ${error.message}`);
        }
      }
      if (sent === 0 && !hasText) {
        throw lastError || new Error('telegram image delivery failed for all images');
      }
    }

    return {
      messageId: String(result?.message_id || '')
    };
  }

  async editMessage({ conversation, messageId, text, buttons = [] } = {}) {
    const textChunks = splitTelegramText(text);
    const payload = {
      chat_id: conversation?.externalConversationId,
      message_id: Number(messageId),
      text: textChunks[0]
    };

    if (buttons.length > 0 && textChunks.length === 1) {
      payload.reply_markup = {
        inline_keyboard: [
          buttons.map((button) => ({
            text: button.text,
            callback_data: `cligate:${button.action || button.id || 'action'}:${button.approvalId || ''}`
          }))
        ]
      };
    }

    await this.callApi('editMessageText', payload);

    for (let index = 1; index < textChunks.length; index += 1) {
      await this.sendMessage({
        conversation,
        text: textChunks[index],
        buttons: index === textChunks.length - 1 ? buttons : []
      });
    }

    return { messageId: String(messageId || '') };
  }

  async answerCallback({ callbackQueryId, text = '' } = {}) {
    await this.callApi('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text
    });
    return { ok: true };
  }
}

export default TelegramChannelProvider;
