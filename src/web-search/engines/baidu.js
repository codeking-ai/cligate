import { stripTags } from '../html-text.js';
import { BROWSER_USER_AGENT } from './duckduckgo.js';

// Keyless Baidu engine — the engine that matters on mainland-China networks
// where DuckDuckGo/Mojeek may be unreachable, and the best index for Chinese
// queries (the search service puts it first for CJK queries).
//
// Quirks handled here, observed in live probing:
//   - Without a BAIDUID cookie Baidu often answers with a ~1KB JS shell
//     instead of the SSR result page → bootstrap a cookie once per process
//     and detect the shell so the service falls through to the next engine.
//   - Result hrefs point at www.baidu.com/link?url=… redirects; the real URL
//     usually sits in the result block's mu="…" attribute — prefer it.
const BAIDU_HOME = 'https://www.baidu.com/';
const BAIDU_SEARCH = 'https://www.baidu.com/s';

let cachedCookie = '';

async function bootstrapCookie(fetchImpl, timeoutMs) {
  if (cachedCookie) return cachedCookie;
  try {
    const response = await fetchImpl(BAIDU_HOME, {
      headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const setCookie = typeof response.headers?.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers?.get?.('set-cookie')].filter(Boolean);
    const pairs = [];
    for (const line of setCookie) {
      const pair = String(line).split(';')[0].trim();
      if (pair.startsWith('BAIDUID') || pair.startsWith('BIDUPSID') || pair.startsWith('PSTM')) {
        pairs.push(pair);
      }
    }
    cachedCookie = pairs.join('; ');
  } catch {
    cachedCookie = '';
  }
  return cachedCookie;
}

// Exported for tests: reset the per-process cookie cache.
export function resetBaiduCookieCache() {
  cachedCookie = '';
}

export function parseBaiduHtml(html, { limit = 8 } = {}) {
  const text = String(html || '');
  const starts = [];
  const blockRe = /<div[^>]*class="result c-container[^"]*"[^>]*>/gi;
  let match;
  while ((match = blockRe.exec(text)) !== null) {
    starts.push({ index: match.index, openTag: match[0] });
  }

  const results = [];
  for (let i = 0; i < starts.length && results.length < limit; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1].index : Math.min(text.length, starts[i].index + 30000);
    const block = text.slice(starts[i].index, end);
    const muMatch = /\bmu="(https?:\/\/[^"]+)"/.exec(starts[i].openTag);
    const heading = /<h3[^>]*>[\s\S]*?<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/i.exec(block);
    if (!heading) continue;
    const title = stripTags(heading[2]);
    // Prefer the real URL from mu=; fall back to Baidu's /link?url= redirect,
    // which still resolves (302) for web_fetch even if it cites poorly.
    const url = muMatch ? muMatch[1] : stripTags(heading[1]);
    if (!title || !url.startsWith('http')) continue;
    const snippetMatch = /<span class="content-right[^"]*">([\s\S]*?)<\/span>/i.exec(block)
      || /<div class="c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)
      || /<span class="c-color-text[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block);
    results.push({ title, url, snippet: snippetMatch ? stripTags(snippetMatch[1]) : '' });
  }
  return results;
}

export async function searchBaidu({ query, limit = 8, fetchImpl, timeoutMs = 12000 }) {
  const cookie = await bootstrapCookie(fetchImpl, timeoutMs);
  const url = `${BAIDU_SEARCH}?wd=${encodeURIComponent(String(query))}&rn=${Math.max(limit, 10)}`;
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'text/html',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(cookie ? { Cookie: cookie } : {})
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`baidu responded with HTTP ${response.status}`);
  }
  const html = await response.text();
  if (html.length < 10000 || html.includes('wappass.baidu.com')) {
    cachedCookie = ''; // stale/blocked cookie — re-bootstrap next time
    throw new Error('baidu served a JS shell / verification page instead of results');
  }
  return parseBaiduHtml(html, { limit });
}

export default { searchBaidu, parseBaiduHtml, resetBaiduCookieCache };
