import { stripTags, decodeHtmlEntities } from '../html-text.js';
import { BROWSER_USER_AGENT } from './duckduckgo.js';

// Keyless fallback engine scraping Bing's HTML SERP. SERP markup is fragile
// by nature, so this is never the only path — the search service falls back
// here only when the engines before it produced nothing. Notably Bing is the
// engine that stays reachable on mainland-China networks where DuckDuckGo is
// blocked, so this fallback IS the primary path for part of the user base.
const BING_ENDPOINT = 'https://www.bing.com/search';

// Bing wraps result hrefs in a click-tracking redirect:
//   https://www.bing.com/ck/a?!&&p=…&u=a1<base64url-of-real-url>&ntb=1
// The real URL is the `u` param minus its "a1" prefix, base64url-encoded.
export function decodeBingHref(href) {
  const raw = decodeHtmlEntities(String(href || '').trim());
  if (!raw) return '';
  if (!raw.includes('bing.com/ck/a')) {
    return raw.startsWith('http') ? raw : '';
  }
  const match = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(raw);
  if (!match) return '';
  try {
    const b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return decoded.startsWith('http') ? decoded : '';
  } catch {
    return '';
  }
}

export function parseBingHtml(html, { limit = 8 } = {}) {
  const text = String(html || '');

  // Blocks can contain nested <li>, so a lazy …</li> match truncates them.
  // Slice from each b_algo opening tag to the next one instead.
  const starts = [];
  const blockRe = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>/gi;
  let match;
  while ((match = blockRe.exec(text)) !== null) starts.push(match.index);

  const results = [];
  for (let i = 0; i < starts.length && results.length < limit; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : Math.min(text.length, starts[i] + 20000);
    const block = text.slice(starts[i], end);
    const heading = /<h2[^>]*>([\s\S]*?)<\/h2\s*>/i.exec(block);
    if (!heading) continue;
    const anchor = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/i.exec(heading[1]);
    if (!anchor) continue;
    const url = decodeBingHref(anchor[1]);
    const title = stripTags(anchor[2]);
    if (!url || !title) continue;
    const snippet = /<p\b[^>]*>([\s\S]*?)<\/p\s*>/i.exec(block);
    results.push({ title, url, snippet: snippet ? stripTags(snippet[1]) : '' });
  }
  return results;
}

export async function searchBing({ query, limit = 8, fetchImpl, timeoutMs = 12000 }) {
  const url = `${BING_ENDPOINT}?q=${encodeURIComponent(String(query))}&count=${Math.max(limit, 10)}`;
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'text/html',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`bing responded with HTTP ${response.status}`);
  }
  return parseBingHtml(await response.text(), { limit });
}

export default { searchBing, parseBingHtml, decodeBingHref };
