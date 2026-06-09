import { createNormalizedChannelMessage } from '../models.js';
import {
  MessageType,
  WEIXIN_API_BASE_URL,
  WeixinClient,
  textFromWeixinItemList
} from './weixin/client.js';
import { normalizeWeixinAccountId, weixinAccountStore } from './weixin/account-store.js';

const WEIXIN_SAFE_MESSAGE_LIMIT = 1800;
const DEFAULT_POLLING_INTERVAL_MS = 3000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const RETRY_DELAY_MS = 2000;
const BACKOFF_DELAY_MS = 30_000;

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
      return `Session ${result?.session?.id || ''} cancelled.`;
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

function splitWeixinText(text, maxLength = WEIXIN_SAFE_MESSAGE_LIMIT) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!source) return [''];
  if (source.length <= maxLength) return [source];

  const chunks = [];
  let remaining = source;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxLength);
    if (splitAt <= 0) splitAt = maxLength;
    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length <= 1
    ? chunks
    : chunks.map((chunk, index) => `[${index + 1}/${chunks.length}] ${chunk}`);
}

function normalizeAccount(accountStore, accountId) {
  const id = normalizeWeixinAccountId(accountId);
  const stored = accountStore.readAccount(id);
  return {
    accountId: id,
    token: stored?.token || '',
    baseUrl: stored?.baseUrl || WEIXIN_API_BASE_URL,
    userId: stored?.userId || ''
  };
}

export class WeixinChannelProvider {
  constructor({
    client = new WeixinClient(),
    accountStore = weixinAccountStore
  } = {}) {
    this.id = 'weixin';
    this.label = 'WeChat';
    this.client = client;
    this.accountStore = accountStore;
    this.capabilities = {
      mode: 'polling',
      supportedModes: ['polling'],
      supportsWebhook: false,
      supportsPolling: true,
      supportsInteractiveApproval: false,
      supportsRichCard: false,
      supportsThreading: false,
      supportsEditMessage: false
    };
    this.configFields = [
      { key: 'enabled', type: 'boolean', labelKey: 'channelEnabled', section: 'basic' },
      { key: 'mode', type: 'select', labelKey: 'channelMode', section: 'basic', options: [{ value: 'polling', labelKey: 'channelModePolling' }], descriptionKey: 'channelWeixinModeDesc' },
      { key: 'accountId', type: 'text', labelKey: 'channelWeixinAccountId', placeholderKey: 'channelWeixinAccountIdPlaceholder', section: 'auth', descriptionKey: 'channelWeixinAccountIdDesc' },
      { key: 'pollingIntervalMs', type: 'number', labelKey: 'channelPollInterval', section: 'transport' },
      { key: 'defaultRuntimeProvider', type: 'runtime-provider', labelKey: 'channelDefaultRuntime', section: 'runtime' },
      { key: 'cwd', type: 'text', labelKey: 'channelWorkingDirectory', section: 'runtime' },
      { key: 'requirePairing', type: 'boolean', labelKey: 'channelRequirePairing', section: 'security' }
    ];
    this.running = false;
    this.timer = null;
    this.pollInFlight = false;
    this.consecutiveFailures = 0;
    this.nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
    this.notifiedStart = false;
    this.settings = null;
    this.router = null;
    this.logger = console;
  }

  getStatus() {
    return {
      running: this.running,
      mode: this.settings?.mode || this.capabilities.mode,
      accountId: this.settings?.accountId || ''
    };
  }

  async start({ settings, router, logger } = {}) {
    this.settings = settings || {};
    this.router = router || null;
    this.logger = logger || console;

    if ((this.settings.mode || 'polling') !== 'polling') {
      return { started: false, reason: `unsupported weixin mode: ${this.settings.mode}` };
    }
    if (!this.settings.accountId) {
      return { started: false, reason: 'weixin accountId is not configured; scan QR to bind first' };
    }
    const account = normalizeAccount(this.accountStore, this.settings.accountId);
    if (!account.token) {
      return { started: false, reason: 'weixin account token is not available; scan QR to bind first' };
    }

    this.running = true;
    this.consecutiveFailures = 0;
    this.nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
    this.notifiedStart = false;
    this._scheduleNextPoll(0);
    return { started: true };
  }

  async stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const accountId = this.settings?.accountId;
    if (accountId) {
      const account = normalizeAccount(this.accountStore, accountId);
      if (account.token) {
        this.client.notifyStop(account).catch((error) => {
          this.logger?.warn?.(`[Weixin] notifyStop failed: ${error.message}`);
        });
      }
    }
    return { stopped: true };
  }

  _scheduleNextPoll(delayMs = null) {
    if (!this.running) return;
    const configured = Number(this.settings?.pollingIntervalMs || DEFAULT_POLLING_INTERVAL_MS);
    const waitMs = Number.isFinite(Number(delayMs)) ? Number(delayMs) : configured;
    this.timer = setTimeout(() => {
      this.pollOnce().catch((error) => {
        this.logger?.warn?.(`[Weixin] Poll failed: ${error.message}`);
      });
    }, Math.max(0, waitMs));
  }

  normalizeInbound(message, accountId) {
    const text = textFromWeixinItemList(message?.item_list);
    const from = String(message?.from_user_id || '').trim();
    if (!from || !String(message?.message_id || '').trim()) return null;
    return createNormalizedChannelMessage({
      channel: 'weixin',
      accountId: this.instanceId || 'default',
      deliveryMode: 'polling',
      externalMessageId: String(message.message_id || ''),
      externalConversationId: from,
      externalUserId: from,
      externalUserName: from || 'WeChat',
      text,
      messageType: text ? 'text' : 'unsupported',
      metadata: {
        accountId,
        contextToken: String(message?.context_token || '').trim()
      },
      raw: message
    });
  }

  async pollOnce() {
    if (!this.running || this.pollInFlight) return 0;
    const account = normalizeAccount(this.accountStore, this.settings?.accountId);
    if (!account.token) {
      this.running = false;
      throw new Error('weixin account token is not available');
    }

    this.pollInFlight = true;
    try {
      if (!this.notifiedStart) {
        this.notifiedStart = true;
        this.client.notifyStart(account).catch(() => {});
      }
      const cursor = this.accountStore.readSyncCursor(account.accountId);
      const resp = await this.client.getUpdates(account, cursor, this.nextTimeoutMs);
      if (typeof resp.longpolling_timeout_ms === 'number' && resp.longpolling_timeout_ms > 0) {
        this.nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const ret = Number(resp.ret ?? 0);
      const errcode = Number(resp.errcode ?? 0);
      if (ret !== 0 || errcode !== 0) {
        this.consecutiveFailures += 1;
        return 0;
      }
      this.consecutiveFailures = 0;

      const nextCursor = typeof resp.get_updates_buf === 'string' ? resp.get_updates_buf : '';
      if (nextCursor) {
        this.accountStore.saveSyncCursor(account.accountId, nextCursor);
      }

      let processed = 0;
      const messages = Array.isArray(resp.msgs) ? resp.msgs : [];
      for (const message of messages) {
        if (!this.running) break;
        if (message?.message_type === MessageType.BOT) continue;
        const to = String(message?.from_user_id || '').trim();
        const contextToken = String(message?.context_token || '').trim();
        if (contextToken && to) {
          this.accountStore.saveContextToken(account.accountId, to, contextToken);
        }
        const normalized = this.normalizeInbound(message, account.accountId);
        if (!normalized) continue;
        if (!normalized.text) {
          await this.sendMessage({
            conversation: { externalConversationId: normalized.externalConversationId },
            text: 'Only text and transcribed voice messages are supported right now.'
          }).catch(() => {});
          processed += 1;
          continue;
        }
        try {
          const result = await this.router.routeInboundMessage(normalized, {
            defaultRuntimeProvider: this.settings?.defaultRuntimeProvider || 'codex',
            requirePairing: this.settings?.requirePairing === true,
            cwd: this.settings?.cwd || ''
          });
          await this.handleRouterResult(normalized, result);
        } catch (error) {
          await this.sendMessage({
            conversation: { externalConversationId: normalized.externalConversationId },
            text: buildRouterFailureText(error)
          });
        }
        processed += 1;
      }

      return processed;
    } finally {
      this.pollInFlight = false;
      if (this.running) {
        const delay = this.consecutiveFailures >= 3 ? BACKOFF_DELAY_MS : this.consecutiveFailures > 0 ? RETRY_DELAY_MS : null;
        if (this.consecutiveFailures >= 3) this.consecutiveFailures = 0;
        this._scheduleNextPoll(delay);
      }
    }
  }

  async handleRouterResult(inbound, result) {
    const text = buildRouterResultText(result);
    if (!text || result?.type === 'duplicate') return null;
    return this.sendMessage({
      conversation: {
        externalConversationId: inbound.externalConversationId
      },
      text
    });
  }

  async sendMessage({ conversation, text } = {}) {
    const account = normalizeAccount(this.accountStore, this.settings?.accountId);
    if (!account.token) {
      throw new Error('weixin account token is not available');
    }
    const to = String(conversation?.externalConversationId || '').trim();
    if (!to) throw new Error('weixin recipient is missing');
    const chunks = splitWeixinText(text);
    let result = null;
    for (const chunk of chunks) {
      if (!chunk) continue;
      result = await this.client.sendMessage({
        account,
        to,
        text: chunk,
        contextToken: this.accountStore.getContextToken(account.accountId, to)
      });
    }
    return {
      messageId: String(result?.messageId || '')
    };
  }
}

export default WeixinChannelProvider;
