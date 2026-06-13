import { validateOutboundUrl } from './safety.js';
import { htmlToText, extractTitle } from './html-text.js';
import { BROWSER_USER_AGENT } from './engines/duckduckgo.js';

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 20000;
const MIN_MAX_CHARS = 1000;
const MAX_MAX_CHARS = 50000;

const TEXTUAL_CONTENT_RE = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|javascript))/i;

function clampMaxChars(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_CHARS;
  return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, parsed));
}

export class WebPageReader {
  constructor({ fetchImpl = globalThis.fetch.bind(globalThis), env = process.env } = {}) {
    this.fetchImpl = fetchImpl;
    this.env = env;
    this.cache = new Map();
  }

  timeoutMs() {
    const parsed = Number.parseInt(String(this.env.CLIGATE_WEB_FETCH_TIMEOUT_MS || ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
  }

  cacheGet(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  cacheSet(key, value) {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: Date.now(), value });
  }

  async fetchOnce(url) {
    return this.fetchImpl(url, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(this.timeoutMs())
    });
  }

  // Returns { ok: true, url, finalUrl, title, contentType, totalChars,
  // truncated, text } or { ok: false, kind, error } — kinds: invalid_url,
  // fetch_failed, unsupported_content.
  async read({ url, maxChars } = {}) {
    const validation = validateOutboundUrl(url);
    if (!validation.ok) {
      return { ok: false, kind: 'invalid_url', error: validation.reason };
    }
    const effectiveMaxChars = clampMaxChars(maxChars);
    const requestedUrl = validation.url.href;

    const cached = this.cacheGet(requestedUrl);
    const page = cached || await this.fetchPage(validation.url);
    if (!page.ok) return page;
    if (!cached) this.cacheSet(requestedUrl, page);

    const truncated = page.text.length > effectiveMaxChars;
    return {
      ok: true,
      url: requestedUrl,
      finalUrl: page.finalUrl,
      title: page.title,
      contentType: page.contentType,
      totalChars: page.text.length,
      truncated,
      text: truncated ? `${page.text.slice(0, effectiveMaxChars)}\n\n[content truncated at ${effectiveMaxChars} chars]` : page.text
    };
  }

  // Upgrade http→https like claude-code does, but keep one retry on the
  // original http URL — small sites are still http-only.
  async fetchPage(parsedUrl) {
    const attempts = [];
    if (parsedUrl.protocol === 'http:') {
      const upgraded = new URL(parsedUrl.href);
      upgraded.protocol = 'https:';
      attempts.push(upgraded.href, parsedUrl.href);
    } else {
      attempts.push(parsedUrl.href);
    }

    let lastError = '';
    for (const attempt of attempts) {
      let response;
      try {
        response = await this.fetchOnce(attempt);
      } catch (error) {
        lastError = String(error?.message || error);
        continue;
      }
      if (!response.ok) {
        lastError = `HTTP ${response.status} from ${attempt}`;
        continue;
      }
      return this.extractBody(response, attempt);
    }
    return { ok: false, kind: 'fetch_failed', error: lastError || 'fetch failed' };
  }

  async extractBody(response, requestedUrl) {
    const contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType && !TEXTUAL_CONTENT_RE.test(contentType)) {
      return {
        ok: false,
        kind: 'unsupported_content',
        error: `content-type "${contentType}" is not text — web_fetch only reads textual pages`
      };
    }

    let buffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (error) {
      return { ok: false, kind: 'fetch_failed', error: `failed reading body: ${String(error?.message || error)}` };
    }
    const bytes = buffer.byteLength > MAX_RESPONSE_BYTES ? buffer.slice(0, MAX_RESPONSE_BYTES) : buffer;
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const finalUrl = String(response.url || requestedUrl);

    if (!contentType || contentType.includes('html')) {
      return {
        ok: true,
        finalUrl,
        contentType: contentType || 'text/html',
        title: extractTitle(raw),
        text: htmlToText(raw, { baseUrl: finalUrl })
      };
    }
    return { ok: true, finalUrl, contentType, title: '', text: raw.trim() };
  }
}

export const webPageReader = new WebPageReader();

export default webPageReader;
