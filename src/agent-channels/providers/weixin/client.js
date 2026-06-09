import { randomBytes, randomUUID } from 'crypto';
import { createRequire } from 'module';

const requireFromHere = createRequire(import.meta.url);

export const WEIXIN_API_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const WEIXIN_DEFAULT_BOT_TYPE = '3';
export const WEIXIN_DEFAULT_APP_ID = 'bot';
export const MessageType = Object.freeze({
  BOT: 2
});
export const MessageItemType = Object.freeze({
  TEXT: 1,
  VOICE: 3
});
export const MessageState = Object.freeze({
  FINISH: 2
});

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function recordString(record, key) {
  const value = asRecord(record)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function resolveBundledWeixinPackageInfo() {
  try {
    const packageJsonPath = requireFromHere.resolve('@tencent-weixin/openclaw-weixin/package.json');
    const pkg = requireFromHere(packageJsonPath);
    return {
      version: typeof pkg?.version === 'string' ? pkg.version : '0.0.0',
      appId: typeof pkg?.ilink_appid === 'string' ? pkg.ilink_appid : ''
    };
  } catch {
    return null;
  }
}

export function assertBundledWeixinPackageInfo(packageInfo = resolveBundledWeixinPackageInfo()) {
  if (!packageInfo?.version || packageInfo.version === '0.0.0') {
    throw new Error('WeChat login component is missing. Run npm install to install @tencent-weixin/openclaw-weixin.');
  }
  return packageInfo;
}

function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version || '0.0.0')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isFinite(part) ? part : 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf8').toString('base64');
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { message: text.trim() || response.statusText };
  }
}

export class WeixinClient {
  constructor({
    fetchImpl = globalThis.fetch,
    appVersion = '0.0.0',
    packageInfo = null,
    appId = '',
    clientVersion = '',
    botAgent = ''
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.appVersion = appVersion;
    this.packageInfo = packageInfo || resolveBundledWeixinPackageInfo();
    this.appId = String(appId || this.packageInfo?.appId || WEIXIN_DEFAULT_APP_ID).trim();
    this.version = String(clientVersion || this.packageInfo?.version || '0.0.0').trim();
    this.botAgent = String(botAgent || `CliGate/${this.appVersion || '0.0.0'}`).trim();
  }

  assertReady() {
    this.packageInfo = assertBundledWeixinPackageInfo(this.packageInfo);
    this.appId = String(this.appId || this.packageInfo.appId || WEIXIN_DEFAULT_APP_ID).trim();
    this.version = String(this.version || this.packageInfo.version || '0.0.0').trim();
  }

  buildBaseInfo() {
    this.assertReady();
    return {
      channel_version: this.version,
      bot_agent: this.botAgent
    };
  }

  buildCommonHeaders() {
    this.assertReady();
    return {
      'iLink-App-Id': this.appId,
      'iLink-App-ClientVersion': String(buildClientVersion(this.version))
    };
  }

  buildHeaders(token = '') {
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomWechatUin(),
      ...this.buildCommonHeaders(),
      ...(String(token || '').trim() ? { Authorization: `Bearer ${String(token).trim()}` } : {})
    };
  }

  async get(baseUrl, endpoint, { timeoutMs = 15_000, label = 'weixinGet' } = {}) {
    const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    const response = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: this.buildCommonHeaders(),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(`${label} ${response.status}: ${recordString(data, 'message') || JSON.stringify(data)}`);
    }
    return data;
  }

  async post(baseUrl, endpoint, body = {}, { token = '', timeoutMs = 15_000, label = 'weixinPost' } = {}) {
    const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    const response = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: this.buildHeaders(token),
      body: JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
    });
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(`${label} ${response.status}: ${recordString(data, 'message') || JSON.stringify(data)}`);
    }
    return data;
  }

  async fetchQRCode({ botType = WEIXIN_DEFAULT_BOT_TYPE, localTokenList = [] } = {}) {
    return this.post(
      WEIXIN_API_BASE_URL,
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      { local_token_list: Array.isArray(localTokenList) ? localTokenList : [] },
      { label: 'fetchQRCode' }
    );
  }

  async pollQRCodeStatus({ baseUrl = WEIXIN_API_BASE_URL, qrcode, timeoutMs = 35_000 } = {}) {
    return this.get(
      baseUrl,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(String(qrcode || ''))}`,
      { timeoutMs, label: 'pollQRCodeStatus' }
    );
  }

  async notifyStart(account) {
    return this.post(
      account.baseUrl || WEIXIN_API_BASE_URL,
      'ilink/bot/msg/notifystart',
      { base_info: this.buildBaseInfo() },
      { token: account.token, timeoutMs: 10_000, label: 'notifyStart' }
    );
  }

  async notifyStop(account) {
    return this.post(
      account.baseUrl || WEIXIN_API_BASE_URL,
      'ilink/bot/msg/notifystop',
      { base_info: this.buildBaseInfo() },
      { token: account.token, timeoutMs: 10_000, label: 'notifyStop' }
    );
  }

  async getUpdates(account, getUpdatesBuf = '', timeoutMs = 35_000) {
    try {
      return await this.post(
        account.baseUrl || WEIXIN_API_BASE_URL,
        'ilink/bot/getupdates',
        {
          get_updates_buf: String(getUpdatesBuf || ''),
          base_info: this.buildBaseInfo()
        },
        { token: account.token, timeoutMs, label: 'getUpdates' }
      );
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
      }
      throw error;
    }
  }

  async sendMessage({ account, to, text, contextToken = '', timeoutMs = 15_000 } = {}) {
    const messageId = `cligate-weixin-${randomUUID()}`;
    await this.post(
      account.baseUrl || WEIXIN_API_BASE_URL,
      'ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: String(to || '').trim(),
          client_id: messageId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: String(text || '').trim() } }],
          context_token: String(contextToken || '').trim() || undefined
        },
        base_info: this.buildBaseInfo()
      },
      { token: account.token, timeoutMs, label: 'sendMessage' }
    );
    return { messageId };
  }
}

export function textFromWeixinItemList(itemList) {
  if (!Array.isArray(itemList)) return '';
  for (const item of itemList) {
    const record = asRecord(item);
    if (record.type === MessageItemType.TEXT) {
      const text = asRecord(record.text_item).text;
      if (text != null) return String(text).trim();
    }
    if (record.type === MessageItemType.VOICE) {
      const text = asRecord(record.voice_item).text;
      if (text != null) return String(text).trim();
    }
  }
  return '';
}

export {
  asRecord,
  recordString,
  buildClientVersion,
  resolveBundledWeixinPackageInfo
};

export default WeixinClient;
