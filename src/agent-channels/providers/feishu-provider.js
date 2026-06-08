import crypto from 'crypto';
import { readFileSync } from 'fs';

import { createNormalizedChannelMessage } from '../models.js';
import * as Lark from '@larksuiteoapi/node-sdk';

const FEISHU_SAFE_MESSAGE_LIMIT = 3500;

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

// Authoritative image MIME from the leading magic bytes. Feishu's resource API
// (like Telegram's file CDN) frequently serves images as
// application/octet-stream, which vision models reject — so we never trust the
// response content-type for the data URL; we sniff the bytes and fall back to
// an image/* type.
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
    throw new Error('invalid data url for feishu image upload');
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

function readMessageText(content) {
  if (!content) return '';
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      return String(parsed?.text || '');
    } catch {
      return String(content);
    }
  }
  return String(content?.text || '');
}

// A Feishu image message carries its resource id as `image_key` inside the
// content (a JSON string for webhook/SDK events, sometimes an object).
function readImageKey(content) {
  if (!content) return '';
  if (typeof content === 'string') {
    try {
      return String(JSON.parse(content)?.image_key || '').trim();
    } catch {
      return '';
    }
  }
  return String(content?.image_key || '').trim();
}

function splitFeishuText(text, maxLength = FEISHU_SAFE_MESSAGE_LIMIT) {
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

  return chunks.map((chunk, index) => `[${index + 1}/${chunks.length}] ${chunk}`);
}

function buildButtonCommandText(buttons = []) {
  const normalized = Array.isArray(buttons)
    ? buttons
      .map((button) => {
        const action = String(button?.action || button?.id || '').trim();
        if (!action) {
          return '';
        }
        const label = String(button?.text || action).trim();
        return label
          ? `${label} (/${action})`
          : `/${action}`;
      })
      .filter(Boolean)
    : [];

  return normalized.length > 0
    ? `\n\nActions: ${normalized.join(' / ')}`
    : '';
}

export class FeishuChannelProvider {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.id = 'feishu';
    this.label = 'Feishu';
    this.fetchImpl = fetchImpl;
    this.capabilities = {
      mode: 'websocket',
      supportedModes: ['websocket', 'webhook'],
      supportsWebhook: true,
      supportsPolling: false,
      supportsWebsocket: true,
      supportsInteractiveApproval: true,
      supportsRichCard: true,
      supportsThreading: true,
      supportsEditMessage: false
    };
    this.configFields = [
      { key: 'enabled', type: 'boolean', labelKey: 'channelEnabled', section: 'basic' },
      {
        key: 'mode',
        type: 'select',
        labelKey: 'channelMode',
        section: 'basic',
        options: [
          { value: 'websocket', labelKey: 'channelModeWebsocket' },
          { value: 'webhook', labelKey: 'channelModeWebhook' }
        ],
        descriptionKey: 'channelFeishuModeDesc'
      },
      { key: 'appId', type: 'text', labelKey: 'channelAppId', section: 'auth' },
      { key: 'appSecret', type: 'password', labelKey: 'channelAppSecret', section: 'auth' },
      { key: 'verificationToken', type: 'text', labelKey: 'channelVerificationToken', section: 'security' },
      { key: 'encryptKey', type: 'text', labelKey: 'channelEncryptKey', section: 'security' },
      { key: 'defaultRuntimeProvider', type: 'runtime-provider', labelKey: 'channelDefaultRuntime', section: 'runtime' },
      { key: 'cwd', type: 'text', labelKey: 'channelWorkingDirectory', section: 'runtime' },
      { key: 'requirePairing', type: 'boolean', labelKey: 'channelRequirePairing', section: 'security' }
    ];
    this.settings = null;
    this.router = null;
    this.logger = console;
    this.tokenCache = {
      accessToken: '',
      expiresAt: 0
    };
    this.wsClient = null;
    this.sdkClient = null;
  }

  async start({ settings, router, logger } = {}) {
    this.settings = settings || {};
    this.router = router || null;
    this.logger = logger || console;

    if (!this.fetchImpl) {
      return { started: false, reason: 'fetch is unavailable' };
    }
    if (!this.settings?.appId || !this.settings?.appSecret) {
      return { started: false, reason: 'feishu appId/appSecret is not configured' };
    }

    if ((this.settings?.mode || 'websocket') === 'websocket') {
      this.sdkClient = new Lark.Client({
        appId: this.settings.appId,
        appSecret: this.settings.appSecret
      });

      this.wsClient = new Lark.WSClient({
        appId: this.settings.appId,
        appSecret: this.settings.appSecret,
        loggerLevel: Lark.LoggerLevel.info
      });

      this.wsClient.start({
        eventDispatcher: new Lark.EventDispatcher({}).register({
          'im.message.receive_v1': async (data) => {
            await this.handleWebhook({
              header: { event_type: 'im.message.receive_v1' },
              event: data
            });
          }
        })
      });
    }

    return { started: true, mode: this.settings?.mode || 'websocket' };
  }

  async stop() {
    try {
      this.wsClient?.close?.({ force: true });
    } catch (error) {
      this.logger?.warn?.(`[Feishu] Failed to close websocket client: ${error.message}`);
    }
    this.wsClient = null;
    this.sdkClient = null;
    return { stopped: true };
  }

  async getTenantAccessToken() {
    if (this.tokenCache.accessToken && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.accessToken;
    }

    const response = await this.fetchImpl(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify({
          app_id: this.settings?.appId,
          app_secret: this.settings?.appSecret
        })
      }
    );

    const data = await response.json();
    if (!response.ok || Number(data?.code) !== 0 || !data?.tenant_access_token) {
      throw new Error(data?.msg || 'Failed to get Feishu tenant access token');
    }

    const expiresIn = Number(data.expire || 7200);
    this.tokenCache = {
      accessToken: String(data.tenant_access_token || ''),
      expiresAt: Date.now() + Math.max(60000, (expiresIn - 60) * 1000)
    };
    return this.tokenCache.accessToken;
  }

  normalizeInbound(payload) {
    const event = payload?.event || payload?.header?.event_type ? payload.event || payload : null;
    const eventType = payload?.header?.event_type || payload?.schema || '';

    if (payload?.challenge) {
      return {
        type: 'challenge',
        challenge: String(payload.challenge || '')
      };
    }

    if (eventType === 'im.message.receive_v1' && event?.message?.message_type === 'text') {
      return createNormalizedChannelMessage({
        channel: 'feishu',
        accountId: this.instanceId || 'default',
        deliveryMode: 'webhook',
        externalMessageId: String(event.message?.message_id || ''),
        externalConversationId: String(event.message?.chat_id || ''),
        externalUserId: String(event.sender?.sender_id?.open_id || ''),
        externalUserName: String(event.sender?.sender_type || 'user'),
        text: readMessageText(event.message?.content),
        messageType: 'text',
        raw: payload
      });
    }

    if (eventType === 'im.message.receive_v1' && event?.message?.message_type === 'image') {
      const imageKey = readImageKey(event.message?.content);
      return createNormalizedChannelMessage({
        channel: 'feishu',
        accountId: this.instanceId || 'default',
        deliveryMode: 'webhook',
        externalMessageId: String(event.message?.message_id || ''),
        externalConversationId: String(event.message?.chat_id || ''),
        externalUserId: String(event.sender?.sender_id?.open_id || ''),
        externalUserName: String(event.sender?.sender_type || 'user'),
        text: '',
        messageType: 'image',
        metadata: {
          imageKey,
          messageId: String(event.message?.message_id || '')
        },
        raw: payload
      });
    }

    return null;
  }

  // Download an inbound Feishu image and turn it into assistant inputParts. We
  // fetch the bytes ourselves (the message-resource API) and embed them as a
  // base64 data URL — keeping image receipt fully local, with no upstream URL
  // fetch and no token-bearing URL leaking into the prompt.
  async buildInboundImageParts(inbound = {}) {
    const messageId = String(inbound?.metadata?.messageId || inbound?.externalMessageId || '').trim();
    const imageKey = String(inbound?.metadata?.imageKey || '').trim();
    if (!messageId || !imageKey) {
      return [];
    }
    const token = await this.getTenantAccessToken();
    const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`;
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    if (!response || response.ok === false) {
      throw new Error('failed to download feishu inbound image');
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const headerType = String(response.headers?.get?.('content-type') || '').trim().toLowerCase();
    const mediaType = sniffImageMediaType(buffer)
      || (isImageMimeType(headerType) ? headerType : '')
      || 'image/jpeg';
    const dataUrl = `data:${mediaType};base64,${buffer.toString('base64')}`;
    return [{ type: 'input_image', image_url: dataUrl, media_type: mediaType }];
  }

  // Enrich a normalized image message with downloaded image inputParts so the
  // assistant can see it. On failure we still route a text placeholder so the
  // sender is never silently ignored.
  async resolveInboundImage(normalized) {
    if (normalized?.messageType !== 'image') {
      return normalized;
    }
    try {
      const inputParts = await this.buildInboundImageParts(normalized);
      return createNormalizedChannelMessage({
        ...normalized,
        text: normalized.text || '[Feishu image]',
        inputParts
      });
    } catch (error) {
      this.logger?.warn?.(`[Feishu] Failed to fetch inbound image: ${error.message}`);
      return createNormalizedChannelMessage({
        ...normalized,
        text: normalized.text || '[Feishu image — failed to download]'
      });
    }
  }

  async handleWebhook(payload, options = {}) {
    const base = this.normalizeInbound(payload);
    if (base?.type === 'challenge') {
      return {
        status: 200,
        body: {
          challenge: base.challenge
        }
      };
    }

    if (!base) {
      return {
        status: 200,
        body: {
          success: true,
          ignored: true
        }
      };
    }

    const normalized = await this.resolveInboundImage(base);

    try {
      const result = await this.router.routeInboundMessage(normalized, {
        defaultRuntimeProvider: this.settings?.defaultRuntimeProvider || 'codex',
        requirePairing: this.settings?.requirePairing === true,
        cwd: this.settings?.cwd || options.cwd || ''
      });

      await this.handleRouterResult(normalized, result);
    } catch (error) {
      await this.sendMessage({
        conversation: {
          externalConversationId: normalized.externalConversationId
        },
        text: buildRouterFailureText(error)
      });
    }
    return {
      status: 200,
      body: {
        success: true
      }
    };
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

  async sendTextMessage({ conversation, text } = {}) {
    const textChunks = splitFeishuText(String(text || ''));
    let result = null;

    if (this.sdkClient) {
      for (const chunk of textChunks) {
        const response = await this.sdkClient.im.v1.message.create({
          params: {
            receive_id_type: 'chat_id'
          },
          data: {
            receive_id: conversation?.externalConversationId,
            msg_type: 'text',
            content: JSON.stringify({
              text: chunk
            })
          }
        });

        if (Number(response?.code) !== 0) {
          throw new Error(response?.msg || 'Failed to send Feishu message');
        }

        result = response;
      }

      return {
        messageId: String(result?.data?.message_id || '')
      };
    }

    const token = await this.getTenantAccessToken();
    for (const chunk of textChunks) {
      const response = await this.fetchImpl(
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            receive_id: conversation?.externalConversationId,
            msg_type: 'text',
            content: JSON.stringify({
              text: chunk
            })
          })
        }
      );

      const data = await response.json();
      if (!response.ok || Number(data?.code) !== 0) {
        throw new Error(data?.msg || 'Failed to send Feishu message');
      }

      result = data;
    }

    return {
      messageId: String(result?.data?.message_id || '')
    };
  }

  // Resolve an outbound image into raw bytes locally. Feishu has no "send by
  // URL" message type — every image must be uploaded first to obtain an
  // image_key. CliGate performs the upload itself, so a localhost artifact URL
  // (or a local file path) is reachable here even though the Feishu server
  // could not fetch it directly.
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
        throw new Error(`failed to download feishu image: ${imageUrl}`);
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

    throw new Error('feishu image delivery requires a readable local path, a data URL, or an http(s) image url');
  }

  async uploadImage({ buffer, fileName = 'cligate-image.jpg', mediaType = 'image/jpeg' } = {}) {
    const token = await this.getTenantAccessToken();
    const boundary = `----cligate-${crypto.randomBytes(8).toString('hex')}`;
    const body = buildMultipartFormData({
      boundary,
      fields: [{ name: 'image_type', value: 'message' }],
      file: {
        field: 'image',
        buffer,
        fileName,
        mediaType
      }
    });

    const response = await this.fetchImpl('https://open.feishu.cn/open-apis/im/v1/images', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Authorization: `Bearer ${token}`
      },
      body
    });

    const data = await response.json();
    const imageKey = String(data?.data?.image_key || data?.image_key || '').trim();
    if (!response.ok || Number(data?.code) !== 0 || !imageKey) {
      throw new Error(data?.msg || 'Failed to upload Feishu image');
    }
    return imageKey;
  }

  async sendImageMessage({ conversation, imageKey } = {}) {
    const token = await this.getTenantAccessToken();
    const response = await this.fetchImpl(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          receive_id: conversation?.externalConversationId,
          msg_type: 'image',
          content: JSON.stringify({
            image_key: imageKey
          })
        })
      }
    );

    const data = await response.json();
    if (!response.ok || Number(data?.code) !== 0) {
      throw new Error(data?.msg || 'Failed to send Feishu image message');
    }
    return {
      messageId: String(data?.data?.message_id || '')
    };
  }

  async sendOneImage({ conversation, image } = {}) {
    const bytes = await this.resolveImageBytes(image);
    const imageKey = await this.uploadImage(bytes);
    return this.sendImageMessage({ conversation, imageKey });
  }

  async sendMessage({ conversation, text, buttons = [], images = [] } = {}) {
    const tail = buildButtonCommandText(buttons);
    const combinedText = `${String(text || '')}${tail}`;
    const normalizedImages = normalizeOutboundImageCandidates(images);
    const hasText = Boolean(combinedText.trim());
    let result = null;

    // Preserve the original text path verbatim. Only skip it when this is an
    // image-only delivery, so we don't emit an empty text message.
    if (hasText || normalizedImages.length === 0) {
      result = await this.sendTextMessage({ conversation, text: combinedText });
    }

    if (normalizedImages.length > 0) {
      let sent = 0;
      let lastError = null;
      for (const image of normalizedImages) {
        try {
          result = await this.sendOneImage({ conversation, image });
          sent += 1;
        } catch (error) {
          lastError = error;
          this.logger?.warn?.(`[Feishu] Skipping unsupported outbound image: ${error.message}`);
        }
      }
      if (sent === 0 && !hasText) {
        throw lastError || new Error('feishu image delivery failed for all images');
      }
    }

    return result;
  }

  async replyCardAction(payload = {}) {
    return this.sendMessage(payload);
  }
}

export default FeishuChannelProvider;
