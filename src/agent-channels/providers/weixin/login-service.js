import { randomUUID } from 'crypto';
import QRCode from 'qrcode';

import { WEIXIN_API_BASE_URL, WEIXIN_DEFAULT_BOT_TYPE, WeixinClient, recordString } from './client.js';
import { normalizeWeixinAccountId, weixinAccountStore } from './account-store.js';

const LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLoginFresh(login) {
  return login && Date.now() - Number(login.startedAt || 0) < LOGIN_TTL_MS;
}

async function renderQrDataUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('data:image/')) return text;
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320
  });
}

function hasStoredToken(accountStore, accountId) {
  return Boolean(accountId && accountStore.readAccount(accountId)?.token);
}

export class WeixinLoginService {
  constructor({
    client = new WeixinClient(),
    accountStore = weixinAccountStore,
    logger = console
  } = {}) {
    this.client = client;
    this.accountStore = accountStore;
    this.logger = logger;
    this.activeLogins = new Map();
  }

  localTokenList(limit = 10) {
    const ids = this.accountStore.listAccountIds();
    const tokens = [];
    for (let index = ids.length - 1; index >= 0 && tokens.length < limit; index -= 1) {
      const token = this.accountStore.readAccount(ids[index])?.token;
      if (token) tokens.push(token);
    }
    return tokens;
  }

  purgeExpiredLogins() {
    for (const [key, login] of this.activeLogins) {
      if (!isLoginFresh(login)) this.activeLogins.delete(key);
    }
  }

  async startLogin({ force = true, botType = WEIXIN_DEFAULT_BOT_TYPE, accountId = '' } = {}) {
    this.purgeExpiredLogins();
    const sessionKey = accountId ? normalizeWeixinAccountId(accountId) : randomUUID();
    const existing = this.activeLogins.get(sessionKey);
    if (!force && isLoginFresh(existing) && existing.qrcodeUrl) {
      return {
        ok: true,
        url: existing.qrDataUrl || await renderQrDataUrl(existing.qrcodeUrl),
        qrDataUrl: existing.qrDataUrl || await renderQrDataUrl(existing.qrcodeUrl),
        qrValue: existing.qrcodeUrl,
        qrcode: existing.qrcode,
        sessionKey,
        expireIn: Math.max(1, Math.floor((LOGIN_TTL_MS - (Date.now() - existing.startedAt)) / 1000)),
        interval: 3
      };
    }

    const qr = await this.client.fetchQRCode({
      botType,
      localTokenList: this.localTokenList()
    });
    const qrcode = recordString(qr, 'qrcode');
    const qrcodeUrl = recordString(qr, 'qrcode_img_content') || recordString(qr, 'qrcodeUrl') || recordString(qr, 'qrUrl');
    if (!qrcode || !qrcodeUrl) {
      throw new Error(recordString(qr, 'message') || 'WeChat QR response is incomplete.');
    }
    const qrDataUrl = await renderQrDataUrl(qrcodeUrl);
    this.activeLogins.set(sessionKey, {
      sessionKey,
      accountId: accountId ? normalizeWeixinAccountId(accountId) : '',
      qrcode,
      qrcodeUrl,
      qrDataUrl,
      startedAt: Date.now(),
      currentApiBaseUrl: WEIXIN_API_BASE_URL
    });
    return {
      ok: true,
      url: qrDataUrl,
      qrDataUrl,
      qrValue: qrcodeUrl,
      qrcode,
      sessionKey,
      expireIn: Math.floor(LOGIN_TTL_MS / 1000),
      interval: 3
    };
  }

  async waitForLogin({ sessionKey, timeoutMs = 35_000 } = {}) {
    const key = String(sessionKey || '').trim();
    const login = this.activeLogins.get(key);
    if (!login) {
      return { connected: false, message: 'No active WeChat login session. Start a new QR login first.' };
    }
    if (!isLoginFresh(login)) {
      this.activeLogins.delete(key);
      return { connected: false, message: 'WeChat QR code expired. Generate a new one.' };
    }

    const deadline = Date.now() + Math.max(Number(timeoutMs) || 35_000, 1000);
    while (Date.now() < deadline) {
      let status = {};
      try {
        status = await this.client.pollQRCodeStatus({
          baseUrl: login.currentApiBaseUrl || WEIXIN_API_BASE_URL,
          qrcode: login.qrcode,
          timeoutMs: QR_LONG_POLL_TIMEOUT_MS
        });
      } catch (error) {
        if (error?.name !== 'TimeoutError') {
          this.logger?.warn?.(`[WeixinLogin] QR status polling failed: ${error.message}`);
        }
        status = { status: 'wait' };
      }

      switch (recordString(status, 'status')) {
        case 'wait':
        case 'scaned':
          break;
        case 'need_verifycode':
          return {
            connected: false,
            message: 'WeChat requested a mobile verification code. This CliGate login flow does not support verification-code entry yet.'
          };
        case 'expired':
          this.activeLogins.delete(key);
          return { connected: false, message: 'WeChat QR code expired. Generate a new one.' };
        case 'verify_code_blocked':
          this.activeLogins.delete(key);
          return { connected: false, message: 'WeChat verification was blocked after repeated failures. Try again later.' };
        case 'binded_redirect':
          this.activeLogins.delete(key);
          {
            const preferredAccountId = login.accountId || this.accountStore.listAccountIds().find((id) => hasStoredToken(this.accountStore, id)) || '';
            if (hasStoredToken(this.accountStore, preferredAccountId)) {
              return {
                connected: true,
                alreadyConnected: true,
                accountId: preferredAccountId,
                sessionKey: key,
                message: 'This CliGate instance is already connected to WeChat.'
              };
            }
            return {
              connected: false,
              alreadyConnected: true,
              message: 'WeChat reports this client is already connected, but no local token was found. Remove stale WeChat state and bind again.'
            };
          }
        case 'scaned_but_redirect': {
          const redirectHost = recordString(status, 'redirect_host');
          if (redirectHost) login.currentApiBaseUrl = `https://${redirectHost}`;
          break;
        }
        case 'confirmed': {
          const rawAccountId = recordString(status, 'ilink_bot_id');
          const token = recordString(status, 'bot_token');
          if (!rawAccountId || !token) {
            this.activeLogins.delete(key);
            return { connected: false, message: 'WeChat login did not return account credentials.' };
          }
          const accountId = normalizeWeixinAccountId(rawAccountId);
          const baseUrl = recordString(status, 'baseurl') || WEIXIN_API_BASE_URL;
          const userId = recordString(status, 'ilink_user_id');
          this.accountStore.saveAccount(accountId, { token, baseUrl, userId });
          this.activeLogins.delete(key);
          return {
            connected: true,
            accountId,
            sessionKey: key,
            baseUrl,
            userId,
            message: 'CliGate is connected to WeChat.'
          };
        }
        default:
          break;
      }
      await sleep(1000);
    }

    return { connected: false, pending: true, message: '' };
  }
}

export const weixinLoginService = new WeixinLoginService();

export default weixinLoginService;
