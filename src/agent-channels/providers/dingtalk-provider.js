import crypto from 'crypto';
import { readFileSync } from 'fs';
import { URL } from 'url';

import { createNormalizedChannelMessage } from '../models.js';

const DINGTALK_TOKEN_CACHE_TTL_MS = 60 * 60 * 1000;
const DINGTALK_TIMESTAMP_SKEW_MS = 60 * 60 * 1000;
const DINGTALK_STREAM_CALLBACK_TOPIC = '/v1.0/im/bot/messages/get';
// Stream reconnect uses capped exponential backoff so a misconfigured or
// permanently-down DingTalk app doesn't spam reconnect attempts (and a log
// line per attempt) every 3 seconds. Real disconnects (transient WebSocket
// closes) still recover within ~3s on the first attempt.
const DINGTALK_STREAM_RECONNECT_BASE_MS = 3000;
const DINGTALK_STREAM_RECONNECT_MAX_MS = 60_000;
// How often to actually emit a warn for a sustained reconnect storm. The
// underlying socket error fires per-frame in some environments; dedup so
// it shows up at most twice per minute.
const DINGTALK_STREAM_ERROR_LOG_INTERVAL_MS = 30_000;
const DINGTALK_SAFE_MESSAGE_LIMIT = 3500;
const DINGTALK_PICTURE_MESSAGE_TYPE = 'picture';
const DINGTALK_IMAGE_DOWNLOAD_PATH = 'https://api.dingtalk.com/v1.0/robot/messageFiles/download';
const DINGTALK_MEDIA_UPLOAD_PATH = 'https://oapi.dingtalk.com/media/upload';

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

function readTextCandidate(payload = {}) {
  if (payload?.text && typeof payload.text === 'string') {
    return payload.text;
  }
  if (payload?.text && typeof payload.text === 'object' && typeof payload.text.content === 'string') {
    return payload.text.content;
  }
  if (typeof payload?.content === 'string') {
    try {
      const parsed = JSON.parse(payload.content);
      if (typeof parsed?.text === 'string') {
        return parsed.text;
      }
      if (typeof parsed?.content === 'string') {
        return parsed.content;
      }
    } catch {
      // fall through to raw content string
    }
    return payload.content;
  }
  if (payload?.content && typeof payload.content === 'object') {
    if (typeof payload.content.text === 'string') {
      return payload.content.text;
    }
    if (typeof payload.content.content === 'string') {
      return payload.content.content;
    }
  }
  return '';
}

function readContentObject(payload = {}) {
  if (payload?.content && typeof payload.content === 'object') {
    return payload.content;
  }
  if (typeof payload?.content === 'string') {
    try {
      const parsed = JSON.parse(payload.content);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function detectInboundMessageType(payload = {}) {
  const explicit = String(
    payload?.msgtype
    || payload?.msgType
    || payload?.messageType
    || payload?.message_type
    || ''
  ).trim().toLowerCase();
  if (explicit) {
    return explicit;
  }
  const content = readContentObject(payload);
  if (
    content.downloadCode
    || content.download_code
    || content.picDownloadCode
    || content.pic_download_code
  ) {
    return DINGTALK_PICTURE_MESSAGE_TYPE;
  }
  return 'text';
}

function inferImageMediaType(fileName = '', downloadCode = '') {
  const normalized = `${String(fileName || '').trim()} ${String(downloadCode || '').trim()}`.toLowerCase();
  if (normalized.includes('.png')) return 'image/png';
  if (normalized.includes('.webp')) return 'image/webp';
  if (normalized.includes('.gif')) return 'image/gif';
  if (normalized.includes('.bmp')) return 'image/bmp';
  return 'image/jpeg';
}

function normalizeOutboundImageCandidates(images = []) {
  if (!Array.isArray(images)) {
    return [];
  }
  return images
    .filter((image) => image && typeof image === 'object')
    .map((image) => ({
      photoURL: String(
        image.photoURL
        || image.photoUrl
        || image.image_url
        || image.imageUrl
        || image.url
        || ''
      ).trim(),
      mediaId: String(image.mediaId || image.media_id || '').trim(),
      mediaType: String(image.mediaType || image.media_type || '').trim(),
      title: String(image.title || '').trim(),
      artifactId: String(image.artifactId || '').trim(),
      path: String(image.path || image.localPath || image.local_path || '').trim()
    }))
    .filter((image) => image.photoURL || image.mediaId || image.path);
}

function isSupportedDingTalkPhotoUrl(photoURL = '') {
  return /^https?:\/\//i.test(String(photoURL || '').trim());
}

function isDataUrl(value = '') {
  return /^data:/i.test(String(value || '').trim());
}

function inferMediaTypeFromPath(path = '') {
  const normalized = String(path || '').trim().toLowerCase();
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.webp')) return 'image/webp';
  if (normalized.endsWith('.gif')) return 'image/gif';
  if (normalized.endsWith('.bmp')) return 'image/bmp';
  return 'image/jpeg';
}

function inferUploadExtension(mediaType = '') {
  const normalized = String(mediaType || '').trim().toLowerCase();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/bmp') return 'bmp';
  return 'jpg';
}

function dataUrlToUploadPayload(dataUrl = '', mediaTypeHint = '') {
  const trimmed = String(dataUrl || '').trim();
  const match = trimmed.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) {
    throw new Error('invalid data url for dingtalk image upload');
  }
  const mediaType = String(mediaTypeHint || match[1] || 'image/jpeg').trim() || 'image/jpeg';
  return {
    buffer: Buffer.from(match[2], 'base64'),
    mediaType,
    fileName: `cligate-image.${inferUploadExtension(mediaType)}`
  };
}

function filePathToUploadPayload(path = '', mediaTypeHint = '') {
  const normalizedPath = String(path || '').trim();
  if (!normalizedPath) {
    throw new Error('image path is required for dingtalk upload');
  }
  const mediaType = String(mediaTypeHint || inferMediaTypeFromPath(normalizedPath)).trim() || 'image/jpeg';
  const extension = inferUploadExtension(mediaType);
  return {
    buffer: readFileSync(normalizedPath),
    mediaType,
    fileName: normalizedPath.split(/[\\/]/).pop() || `cligate-image.${extension}`
  };
}

function buildMultipartFormData({ boundary = '', fields = [], file = null } = {}) {
  const chunks = [];
  for (const field of fields) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${String(field?.name || '')}"\r\n\r\n`
      + `${String(field?.value || '')}\r\n`,
      'utf8'
    ));
  }
  if (file?.buffer) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="media"; filename="${String(file.fileName || 'image.jpg')}"\r\n`
      + `Content-Type: ${String(file.mediaType || 'application/octet-stream')}\r\n\r\n`,
      'utf8'
    ));
    chunks.push(Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function buildWebhookTextBody(text) {
  return {
    msgtype: 'text',
    text: {
      content: String(text || '')
    }
  };
}

function buildSingleTextBody({ robotCode, userId, text }) {
  return {
    robotCode: String(robotCode || ''),
    userIds: [String(userId || '')],
    msgKey: 'sampleText',
    msgParam: JSON.stringify({
      content: String(text || '')
    })
  };
}

function buildGroupTextBody({ robotCode, openConversationId, text }) {
  return {
    robotCode: String(robotCode || ''),
    openConversationId: String(openConversationId || ''),
    msgKey: 'sampleText',
    msgParam: JSON.stringify({
      content: String(text || '')
    })
  };
}

function buildSingleImageBody({ robotCode, userId, photoURL }) {
  return {
    robotCode: String(robotCode || ''),
    userIds: [String(userId || '')],
    msgKey: 'sampleImageMsg',
    msgParam: JSON.stringify({
      photoURL: String(photoURL || '')
    })
  };
}

function buildGroupImageBody({ robotCode, openConversationId, photoURL }) {
  return {
    robotCode: String(robotCode || ''),
    openConversationId: String(openConversationId || ''),
    msgKey: 'sampleImageMsg',
    msgParam: JSON.stringify({
      photoURL: String(photoURL || '')
    })
  };
}

function splitDingTalkText(text, maxLength = DINGTALK_SAFE_MESSAGE_LIMIT) {
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

function coerceTimestamp(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed > 10_000_000_000) {
    return parsed;
  }
  return parsed * 1000;
}

function chooseSetting(settings = {}, ...keys) {
  for (const key of keys) {
    const value = settings?.[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return '';
}

export class DingTalkChannelProvider {
  constructor({
    fetchImpl = globalThis.fetch,
    webSocketFactory = null,
    reconnectDelayMs = DINGTALK_STREAM_RECONNECT_BASE_MS,
    reconnectMaxDelayMs = DINGTALK_STREAM_RECONNECT_MAX_MS
  } = {}) {
    this.id = 'dingtalk';
    this.label = 'DingTalk';
    this.fetchImpl = fetchImpl;
    this.webSocketFactory = webSocketFactory;
    this.reconnectDelayMs = reconnectDelayMs;
    this.reconnectMaxDelayMs = reconnectMaxDelayMs;
    this.capabilities = {
      mode: 'stream',
      supportedModes: ['stream', 'webhook'],
      supportsWebhook: true,
      supportsPolling: false,
      supportsWebsocket: true,
      supportsInteractiveApproval: false,
      supportsRichCard: false,
      supportsThreading: false,
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
          { value: 'stream', labelKey: 'channelModeStream' },
          { value: 'webhook', labelKey: 'channelModeWebhook' }
        ],
        descriptionKey: 'channelDingTalkModeDesc'
      },
      { key: 'clientId', type: 'text', labelKey: 'channelClientId', section: 'auth' },
      { key: 'clientSecret', type: 'password', labelKey: 'channelClientSecret', section: 'auth' },
      { key: 'robotCode', type: 'text', labelKey: 'channelRobotCode', section: 'auth' },
      { key: 'signingSecret', type: 'password', labelKey: 'channelSigningSecret', section: 'security' },
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
    this.streamSocket = null;
    this.streamReconnectTimer = null;
    this.streamClosedByProvider = false;
    // Bumped on every failed reconnect attempt and every socket-level error
    // observed while the socket is still considered "live". Reset to 0 the
    // moment we successfully open a fresh socket. Used to compute the next
    // reconnect delay as
    //   delay = min(MAX, BASE * 2^(consecutive - 1))
    // so the cadence is 3s → 6s → 12s → 24s → 48s → 60s (capped) instead of
    // a flat 3s spam.
    this.streamConsecutiveFailures = 0;
    this.streamLastErrorLogAt = 0;
  }

  async start({ settings, router, logger } = {}) {
    this.settings = settings || {};
    this.router = router || null;
    this.logger = logger || console;
    this.streamClosedByProvider = false;

    if (!this.fetchImpl) {
      return { started: false, reason: 'fetch is unavailable' };
    }
    if (!this.router) {
      return { started: false, reason: 'router is unavailable' };
    }

    const mode = this.settings?.mode || 'stream';
    if (!['stream', 'webhook'].includes(mode)) {
      return { started: false, reason: `unsupported dingtalk mode: ${this.settings?.mode}` };
    }

    if (mode === 'stream') {
      const clientId = chooseSetting(this.settings, 'clientId', 'appKey');
      const clientSecret = chooseSetting(this.settings, 'clientSecret', 'appSecret');
      if (!clientId || !clientSecret) {
        return { started: false, reason: 'dingtalk clientId/clientSecret is not configured' };
      }
      await this.openStreamConnection();
    }

    return { started: true, mode };
  }

  async stop() {
    this.streamClosedByProvider = true;
    if (this.streamReconnectTimer) {
      clearTimeout(this.streamReconnectTimer);
      this.streamReconnectTimer = null;
    }
    try {
      this.streamSocket?.close?.();
    } catch (error) {
      this.logger?.warn?.(`[DingTalk] Failed to close stream socket: ${error.message}`);
    }
    this.streamSocket = null;
    return { stopped: true };
  }

  async createWebSocket(url) {
    if (this.webSocketFactory) {
      return this.webSocketFactory(url);
    }
    if (typeof globalThis.WebSocket === 'function') {
      return new globalThis.WebSocket(url);
    }
    throw new Error('WebSocket is unavailable. Provide webSocketFactory or install a runtime with global WebSocket support.');
  }

  // Log a sustained reconnect/socket error storm at most once every
  // DINGTALK_STREAM_ERROR_LOG_INTERVAL_MS. The first failure logs
  // immediately; subsequent failures within the window are silently counted
  // and shown alongside the next emit.
  _logStreamProblem(level, label, error) {
    const now = Date.now();
    if (now - this.streamLastErrorLogAt < DINGTALK_STREAM_ERROR_LOG_INTERVAL_MS) {
      return;
    }
    this.streamLastErrorLogAt = now;
    const message = String(error?.message || error || 'unknown error');
    const consecutive = this.streamConsecutiveFailures;
    const tail = consecutive > 1 ? ` (consecutive=${consecutive})` : '';
    if (level === 'error') {
      this.logger?.error?.(`[DingTalk] ${label}: ${message}${tail}`);
    } else {
      this.logger?.warn?.(`[DingTalk] ${label}: ${message}${tail}`);
    }
  }

  async openStreamConnection() {
    const connection = await this.registerStreamConnection();
    const target = new URL(String(connection.endpoint || ''));
    target.searchParams.set('ticket', String(connection.ticket || ''));

    const socket = await this.createWebSocket(target.toString());
    this.streamSocket = socket;
    // Reaching this point means register + WebSocket handshake both
    // succeeded — treat that as a healthy connection until proven otherwise.
    this.streamConsecutiveFailures = 0;
    this.streamLastErrorLogAt = 0;

    const onMessage = (data) => { void this.handleStreamFrame(data); };
    const onError = (error) => {
      this.streamConsecutiveFailures += 1;
      this._logStreamProblem('warn', 'Stream socket error', error);
    };
    const onClose = () => {
      if (this.streamSocket === socket) {
        this.streamSocket = null;
      }
      this.scheduleStreamReconnect();
    };

    socket.addEventListener?.('message', (event) => onMessage(event?.data));
    socket.addEventListener?.('error', (error) => onError(error));
    socket.addEventListener?.('close', onClose);

    if (typeof socket.on === 'function') {
      socket.on('message', onMessage);
      socket.on('error', onError);
      socket.on('close', onClose);
    }
  }

  scheduleStreamReconnect() {
    if (this.streamClosedByProvider || (this.settings?.mode || 'stream') !== 'stream') {
      return;
    }
    if (this.streamReconnectTimer) {
      return;
    }
    // Compute next delay using the current failure count. We bump the
    // counter on the failure path (in the .catch below); the close handler
    // alone doesn't count as a failure because a clean close after a brief
    // session is normal.
    const exponent = Math.max(0, this.streamConsecutiveFailures);
    const delay = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectDelayMs * 2 ** Math.min(exponent, 5)
    );
    this.streamReconnectTimer = setTimeout(() => {
      this.streamReconnectTimer = null;
      void this.openStreamConnection().catch((error) => {
        this.streamConsecutiveFailures += 1;
        this._logStreamProblem('warn', 'Failed to reconnect stream', error);
        this.scheduleStreamReconnect();
      });
    }, delay);
  }

  async registerStreamConnection() {
    const clientId = chooseSetting(this.settings, 'clientId', 'appKey');
    const clientSecret = chooseSetting(this.settings, 'clientSecret', 'appSecret');
    const response = await this.fetchImpl('https://api.dingtalk.com/v1.0/gateway/connections/open', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        subscriptions: [
          {
            type: 'CALLBACK',
            topic: DINGTALK_STREAM_CALLBACK_TOPIC
          }
        ],
        ua: 'cligate-dingtalk/1.1.1'
      })
    });

    const data = await response.json();
    if (!response.ok || !data?.endpoint || !data?.ticket) {
      throw new Error(data?.message || data?.msg || 'Failed to open DingTalk stream connection');
    }
    return data;
  }

  buildStreamAck(frame = {}, data = { response: null }) {
    return {
      code: 200,
      headers: {
        messageId: String(frame?.headers?.messageId || ''),
        contentType: 'application/json'
      },
      message: 'OK',
      data: JSON.stringify(data)
    };
  }

  sendStreamAck(frame, data) {
    if (!this.streamSocket) {
      return;
    }
    this.streamSocket.send(JSON.stringify(this.buildStreamAck(frame, data)));
  }

  async handleStreamFrame(rawFrame) {
    let frame;
    try {
      frame = JSON.parse(Buffer.isBuffer(rawFrame) ? rawFrame.toString('utf8') : String(rawFrame || ''));
    } catch {
      return;
    }

    const topic = String(frame?.headers?.topic || '');
    if (frame?.type === 'SYSTEM' && topic === 'ping') {
      let pingData = {};
      try {
        pingData = JSON.parse(String(frame?.data || '{}'));
      } catch {
        pingData = {};
      }
      this.sendStreamAck(frame, { opaque: pingData?.opaque || '' });
      return;
    }

    if (frame?.type === 'SYSTEM' && topic === 'disconnect') {
      return;
    }

    if (frame?.type !== 'CALLBACK' || topic !== DINGTALK_STREAM_CALLBACK_TOPIC) {
      this.sendStreamAck(frame, { response: null });
      return;
    }

    let payload = null;
    try {
      payload = JSON.parse(String(frame?.data || '{}'));
    } catch {
      payload = null;
    }

    if (!payload) {
      this.sendStreamAck(frame, { response: null });
      return;
    }

    try {
      await this.handleWebhook(payload, { skipVerification: true });
      this.sendStreamAck(frame, { response: null });
    } catch (error) {
      this.logger?.warn?.(`[DingTalk] Failed to process stream callback: ${error.message}`);
      this.sendStreamAck(frame, {
        status: 'LATER',
        message: error.message
      });
    }
  }

  verifySignature(payload = {}, options = {}) {
    const signingSecret = chooseSetting(this.settings, 'signingSecret', 'secret');
    if (!signingSecret) {
      return { ok: true, mode: 'disabled' };
    }

    const timestamp = coerceTimestamp(
      options?.headers?.['x-dingtalk-timestamp']
      || options?.headers?.timestamp
      || payload?.timestamp
    );
    const sign = String(
      options?.headers?.['x-dingtalk-signature']
      || options?.headers?.sign
      || payload?.sign
      || ''
    ).trim();

    if (!timestamp || !sign) {
      return { ok: false, reason: 'missing dingtalk signature headers' };
    }

    if (Math.abs(Date.now() - timestamp) > DINGTALK_TIMESTAMP_SKEW_MS) {
      return { ok: false, reason: 'dingtalk signature timestamp expired' };
    }

    const stringToSign = `${timestamp}\n${signingSecret}`;
    const expected = crypto
      .createHmac('sha256', signingSecret)
      .update(stringToSign)
      .digest('base64');

    let actualBuffer;
    let expectedBuffer;
    try {
      actualBuffer = Buffer.from(decodeURIComponent(sign), 'utf8');
      expectedBuffer = Buffer.from(expected, 'utf8');
    } catch {
      return { ok: false, reason: 'invalid dingtalk signature encoding' };
    }

    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
      return { ok: false, reason: 'dingtalk signature mismatch' };
    }

    return { ok: true, mode: 'hmac' };
  }

  async buildInboundImageParts(payload = {}) {
    const content = readContentObject(payload);
    const downloadCode = String(
      content.downloadCode
      || content.download_code
      || content.picDownloadCode
      || content.pic_download_code
      || payload?.downloadCode
      || ''
    ).trim();
    if (!downloadCode) {
      return [];
    }

    const accessToken = await this.getAccessToken();
    const response = await this.fetchImpl(DINGTALK_IMAGE_DOWNLOAD_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken
      },
      body: JSON.stringify({
        downloadCode,
        robotCode: String(payload?.robotCode || chooseSetting(this.settings, 'robotCode')).trim()
      })
    });

    const data = await response.json();
    const imageUrl = String(data.downloadUrl || data.download_url || data.url || '').trim();
    if (!response.ok || !imageUrl) {
      throw new Error('DingTalk image download response missing downloadUrl');
    }

    const parts = [{
      type: 'input_image',
      image_url: imageUrl,
      media_type: inferImageMediaType(
        content.fileName || content.file_name || data.fileName || data.file_name || '',
        downloadCode
      )
    }];
    const caption = String(
      content.caption
      || content.title
      || content.text
      || ''
    ).trim();
    if (caption) {
      parts.unshift({
        type: 'text',
        text: caption
      });
    }
    return parts;
  }

  normalizeInbound(payload = {}) {
    if (payload?.challenge) {
      return {
        type: 'challenge',
        challenge: String(payload.challenge || '')
      };
    }

    const inboundMessageType = detectInboundMessageType(payload);
    const text = String(readTextCandidate(payload) || '').trim();
    const content = readContentObject(payload);
    const conversationId = String(
      payload?.conversationId
      || payload?.openConversationId
      || payload?.chatbotConversationId
      || ''
    ).trim();
    const staffId = String(
      payload?.senderStaffId
      || payload?.staffId
      || payload?.userId
      || ''
    ).trim();
    const userId = String(
      staffId
      || payload?.senderId
      || ''
    ).trim();
    const externalMessageId = String(
      payload?.msgId
      || payload?.messageId
      || payload?.eventId
      || payload?.processQueryKey
      || ''
    ).trim();

    if ((!text && inboundMessageType === 'text') || !conversationId || !userId) {
      return null;
    }

    const baseMessage = {
      channel: 'dingtalk',
      accountId: this.instanceId || 'default',
      deliveryMode: 'webhook',
      externalMessageId,
      externalConversationId: conversationId,
      externalUserId: userId,
      externalUserName: String(payload?.senderNick || payload?.senderName || payload?.nick || ''),
      text,
      messageType: inboundMessageType,
      metadata: {
        sessionWebhook: String(payload?.sessionWebhook || payload?.sessionWebhookExpiredTime ? payload?.sessionWebhook || '' : ''),
        sessionWebhookExpiredTime: String(payload?.sessionWebhookExpiredTime || ''),
        robotCode: String(payload?.robotCode || ''),
        conversationType: String(payload?.conversationType || ''),
        tenantId: String(payload?.conversationTenantId || payload?.tenantId || ''),
        rawConversationId: conversationId,
        senderStaffId: staffId,
        senderId: String(payload?.senderId || ''),
        senderUnionId: String(payload?.senderUnionId || ''),
        rawContent: content
      },
      raw: payload
    };

    return createNormalizedChannelMessage(baseMessage);
  }

  async getAccessToken() {
    if (this.tokenCache.accessToken && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.accessToken;
    }

    const clientId = chooseSetting(this.settings, 'clientId', 'appKey');
    const clientSecret = chooseSetting(this.settings, 'clientSecret', 'appSecret');
    if (!clientId || !clientSecret) {
      throw new Error('dingtalk clientId/clientSecret is not configured');
    }

    const response = await this.fetchImpl('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        appKey: clientId,
        appSecret: clientSecret
      })
    });

    const data = await response.json();
    if (!response.ok || !data?.accessToken) {
      throw new Error(data?.message || data?.msg || 'Failed to get DingTalk access token');
    }

    this.tokenCache = {
      accessToken: String(data.accessToken || ''),
      expiresAt: Date.now() + DINGTALK_TOKEN_CACHE_TTL_MS
    };
    return this.tokenCache.accessToken;
  }

  async sendViaSessionWebhook(sessionWebhook, text) {
    const response = await this.fetchImpl(String(sessionWebhook), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildWebhookTextBody(text))
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok || (data && Number(data?.errcode || 0) !== 0)) {
      throw new Error(data?.errmsg || data?.message || 'Failed to send DingTalk session webhook message');
    }

    return {
      messageId: String(data?.processQueryKey || data?.messageId || '')
    };
  }

  async sendOneImage({ conversation, channelContext, image } = {}) {
    const photoURL = await this.resolveOutboundImageMediaRef(image);
    return this.sendViaAppApi({
      conversationId: conversation?.externalConversationId,
      photoURL,
      robotCode: channelContext.robotCode || '',
      conversationType: channelContext.conversationType || '',
      senderStaffId: channelContext.senderStaffId || ''
    });
  }

  async uploadImageMedia({ buffer, fileName = 'cligate-image.jpg', mediaType = 'image/jpeg' } = {}) {
    const accessToken = await this.getAccessToken();
    const boundary = `----cligate-${crypto.randomBytes(8).toString('hex')}`;
    const body = buildMultipartFormData({
      boundary,
      fields: [{
        name: 'type',
        value: 'image'
      }],
      file: {
        buffer,
        fileName,
        mediaType
      }
    });
    const uploadUrl = `${DINGTALK_MEDIA_UPLOAD_PATH}?access_token=${encodeURIComponent(accessToken)}`;
    const response = await this.fetchImpl(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body
    });

    const data = await response.json();
    const mediaId = String(data?.media_id || data?.mediaId || '').trim();
    if (!response.ok || !mediaId || Number(data?.errcode || 0) !== 0) {
      throw new Error(data?.errmsg || data?.message || 'Failed to upload DingTalk image media');
    }
    return mediaId;
  }

  async resolveOutboundImageMediaRef(image = {}) {
    const mediaId = String(image?.mediaId || '').trim();
    if (mediaId) {
      return mediaId;
    }

    const photoURL = String(image?.photoURL || '').trim();
    if (isSupportedDingTalkPhotoUrl(photoURL)) {
      return photoURL;
    }
    if (isDataUrl(photoURL)) {
      const upload = dataUrlToUploadPayload(photoURL, image?.mediaType || '');
      return this.uploadImageMedia(upload);
    }

    const path = String(image?.path || '').trim();
    if (path) {
      const upload = filePathToUploadPayload(path, image?.mediaType || '');
      return this.uploadImageMedia(upload);
    }

    throw new Error('dingtalk image delivery requires an http(s) photoURL, a mediaId, a data URL, or a readable local image path');
  }

  async sendViaAppApi({ conversationId, text = '', photoURL = '', robotCode, conversationType = '', senderStaffId = '' }) {
    const effectiveRobotCode = String(robotCode || chooseSetting(this.settings, 'robotCode')).trim();
    if (!effectiveRobotCode) {
      throw new Error('dingtalk robotCode is not configured');
    }

    const accessToken = await this.getAccessToken();
    const isGroupConversation = String(conversationType || '').trim() === '2';
    const requestUrl = isGroupConversation
      ? 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'
      : 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';

    if (!isGroupConversation && !String(senderStaffId || '').trim()) {
      throw new Error('dingtalk senderStaffId is required for single-chat app API fallback');
    }

    const response = await this.fetchImpl(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken
      },
      body: JSON.stringify(
        photoURL
          ? (isGroupConversation
              ? buildGroupImageBody({
                robotCode: effectiveRobotCode,
                openConversationId: conversationId,
                photoURL
              })
              : buildSingleImageBody({
                robotCode: effectiveRobotCode,
                userId: senderStaffId,
                photoURL
              }))
          : (isGroupConversation
              ? buildGroupTextBody({
                robotCode: effectiveRobotCode,
                openConversationId: conversationId,
                text
              })
              : buildSingleTextBody({
                robotCode: effectiveRobotCode,
                userId: senderStaffId,
                text
              }))
      )
    });

    const data = await response.json();
    if (!response.ok || data?.code || data?.message) {
      if (!response.ok || data?.code || (data?.success === false)) {
        throw new Error(data?.message || data?.msg || 'Failed to send DingTalk app message');
      }
    }

    return {
      messageId: String(data?.processQueryKey || data?.messageId || '')
    };
  }

  async handleWebhook(payload, options = {}) {
    if (!options.skipVerification) {
      const verification = this.verifySignature(payload, options);
      if (!verification.ok) {
        return {
          status: 401,
          body: {
            success: false,
            error: verification.reason
          }
        };
      }
    }

    let normalized = this.normalizeInbound(payload);
    if (normalized?.messageType === DINGTALK_PICTURE_MESSAGE_TYPE) {
      const inputParts = await this.buildInboundImageParts(payload);
      normalized = createNormalizedChannelMessage({
        ...normalized,
        text: normalized.text || '[DingTalk image]',
        inputParts
      });
    }
    if (normalized?.type === 'challenge') {
      return {
        status: 200,
        body: {
          challenge: normalized.challenge
        }
      };
    }

    if (!normalized) {
      return {
        status: 200,
        body: {
          success: true,
          ignored: true
        }
      };
    }

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
          externalConversationId: normalized.externalConversationId,
          metadata: {
            channelContext: {
              ...((normalized.metadata && typeof normalized.metadata === 'object') ? normalized.metadata : {})
            }
          }
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
        externalConversationId: inbound.externalConversationId,
        metadata: {
          channelContext: {
            ...((inbound.metadata && typeof inbound.metadata === 'object') ? inbound.metadata : {})
          }
        }
      },
      text
    });
  }

  async sendMessage({ conversation, text, buttons = [], images = [] } = {}) {
    const channelContext = conversation?.metadata?.channelContext || {};
    const sessionWebhook = String(channelContext.sessionWebhook || '').trim();
    const expiredAt = coerceTimestamp(channelContext.sessionWebhookExpiredTime);
    const now = Date.now();
    const providerMode = String(this.settings?.mode || 'stream').trim().toLowerCase();
    const normalizedImages = normalizeOutboundImageCandidates(images);
    const sendableImages = normalizedImages.filter((image) => (
      Boolean(image.mediaId)
      || isSupportedDingTalkPhotoUrl(image.photoURL)
      || isDataUrl(image.photoURL)
      || Boolean(image.path)
    ));
    const textWithActions = `${String(text || '')}${buildButtonCommandText(buttons)}`;
    const hasText = Boolean(textWithActions.trim());
    if (normalizedImages.length > 0 && providerMode === 'webhook') {
      throw new Error('dingtalk image delivery is unavailable when the channel is configured in webhook mode; configure app credentials and use stream/app mode instead');
    }
    if (normalizedImages.length > 0 && sendableImages.length !== normalizedImages.length) {
      const unsupportedCount = normalizedImages.length - sendableImages.length;
      this.logger?.warn?.('[DingTalk] Skipping unsupported outbound image(s); supported image sources are mediaId, http(s), data URLs, and readable local paths.');
    }
    if (sendableImages.length > 0 && !hasText) {
      let result = null;
      for (const image of sendableImages) {
        result = await this.sendOneImage({
          conversation,
          channelContext,
          image
        });
      }
      return result;
    }
    if (normalizedImages.length > 0 && !hasText && sendableImages.length === 0) {
      throw new Error('dingtalk image delivery requires a mediaId, an http(s) photoURL, a data URL, or a readable local image path');
    }

    const textChunks = splitDingTalkText(textWithActions);
    let result = null;

    // Prefer the sessionWebhook path when it's still fresh — it's cheap and
    // works for inbound-reply windows. If DingTalk rejects (consumed / session
    // closed server-side), fall through to App API instead of failing.
    if (sessionWebhook && (!expiredAt || expiredAt > now + 15_000)) {
      try {
        for (const chunk of textChunks) {
          result = await this.sendViaSessionWebhook(sessionWebhook, chunk);
        }
        return result;
      } catch (err) {
        // sessionWebhook may already be consumed/expired on DingTalk's side
        // even though `expiredAt` says otherwise. Fall through to App API.
      }
    }

    for (const chunk of textChunks) {
      result = await this.sendViaAppApi({
        conversationId: conversation?.externalConversationId,
        text: chunk,
        robotCode: channelContext.robotCode || '',
        conversationType: channelContext.conversationType || '',
        senderStaffId: channelContext.senderStaffId || ''
      });
    }

    if (sendableImages.length > 0) {
      for (const image of sendableImages) {
        result = await this.sendOneImage({
          conversation,
          channelContext,
          image
        });
      }
    }

    return result;
  }
}

export default DingTalkChannelProvider;
