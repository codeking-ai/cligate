import { createNormalizedChannelMessage } from '../models.js';

function buildRouterResultText(result) {
  switch (result?.type) {
    case 'pairing_required':
      return `Pairing required. Code: ${result?.pairing?.code || ''}`.trim();
    case 'command_error':
      return result.message || 'Command error';
    case 'runtime_started':
      return `Task accepted. Session ${result?.session?.id || ''} started with ${result?.session?.provider || result?.provider || 'agent'}.`.trim();
    case 'runtime_continued':
      return `Sent follow-up to session ${result?.session?.id || ''}.`.trim();
    case 'runtime_cancelled':
      return `Session ${result?.session?.id || ''} cancelled.`.trim();
    case 'runtime_status':
      return `Session ${result?.session?.id || ''}: ${result?.session?.status || 'unknown'}${result?.session?.summary ? `\n${result.session.summary}` : ''}`.trim();
    case 'approval_resolved':
      return `Approval ${result?.approval?.status || 'resolved'}.`;
    case 'question_answered':
      return 'Answer sent to the active task.';
    default:
      return '';
  }
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

export class FeishuChannelProvider {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.id = 'feishu';
    this.fetchImpl = fetchImpl;
    this.capabilities = {
      mode: 'webhook',
      supportsWebhook: true,
      supportsPolling: false,
      supportsInteractiveApproval: true,
      supportsRichCard: true,
      supportsThreading: true,
      supportsEditMessage: false
    };
    this.settings = null;
    this.router = null;
    this.logger = console;
    this.tokenCache = {
      accessToken: '',
      expiresAt: 0
    };
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

    return { started: true };
  }

  async stop() {
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
        accountId: 'default',
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

    return null;
  }

  async handleWebhook(payload, options = {}) {
    const normalized = this.normalizeInbound(payload);
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

    const result = await this.router.routeInboundMessage(normalized, {
      defaultRuntimeProvider: this.settings?.defaultRuntimeProvider || 'codex',
      cwd: this.settings?.cwd || options.cwd || '',
      model: this.settings?.model || options.model || ''
    });

    await this.handleRouterResult(normalized, result);
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

  async sendMessage({ conversation, text, buttons = [] } = {}) {
    const token = await this.getTenantAccessToken();
    const tail = buttons.length > 0
      ? `\n\nActions: ${buttons.map((button) => `/${button.action || button.id}`).join(' / ')}`
      : '';

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
            text: `${String(text || '')}${tail}`
          })
        })
      }
    );

    const data = await response.json();
    if (!response.ok || Number(data?.code) !== 0) {
      throw new Error(data?.msg || 'Failed to send Feishu message');
    }

    return {
      messageId: String(data?.data?.message_id || '')
    };
  }

  async replyCardAction(payload = {}) {
    return this.sendMessage(payload);
  }
}

export default FeishuChannelProvider;
