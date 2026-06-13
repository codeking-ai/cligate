import { stripTags } from '../html-text.js';

// Keyless DuckDuckGo engine. The lite endpoint (a plain HTML table meant for
// text browsers) is tried first: in live probing the classic
// html.duckduckgo.com endpoint answered bot-suspicious requests with an HTTP
// 202 challenge page (zero results), while lite kept serving real results.
// The classic endpoint remains as an in-engine fallback.
const DDG_LITE_ENDPOINT = 'https://lite.duckduckgo.com/lite/';
const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';

export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// DDG wraps result hrefs in a redirect: //duckduckgo.com/l/?uddg=<enc>&rut=…
export function decodeDuckDuckGoHref(href) {
  const raw = String(href || '').trim();
  if (!raw) return '';
  if (raw.includes('duckduckgo.com/y.js') || raw.includes('ad_domain=')) return ''; // ad slot
  const uddgMatch = /[?&]uddg=([^&]+)/.exec(raw);
  if (uddgMatch) {
    try {
      return decodeURIComponent(uddgMatch[1]);
    } catch {
      return '';
    }
  }
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  return '';
}

// lite.duckduckgo.com: a table of <a class='result-link'> rows with
// <td class='result-snippet'> rows in strict alternation (attribute order and
// quoting vary, so match any anchor whose tag mentions result-link).
export function parseDuckDuckGoLiteHtml(html, { limit = 8 } = {}) {
  const text = String(html || '');
  const links = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let match;
  while ((match = anchorRe.exec(text)) !== null) {
    if (!/result-link/.test(match[1])) continue;
    const hrefMatch = /href=["']([^"']*)["']/.exec(match[1]);
    if (!hrefMatch) continue;
    links.push({ href: hrefMatch[1], title: stripTags(match[2]) });
  }
  const snippets = [];
  const snippetRe = /<td\b[^>]*result-snippet[^>]*>([\s\S]*?)<\/td\s*>/gi;
  while ((match = snippetRe.exec(text)) !== null) {
    snippets.push(stripTags(match[1]));
  }

  const results = [];
  for (let i = 0; i < links.length && results.length < limit; i += 1) {
    const url = decodeDuckDuckGoHref(links[i].href);
    if (!url || !links[i].title) continue;
    results.push({ title: links[i].title, url, snippet: snippets[i] || '' });
  }
  return results;
}

export function parseDuckDuckGoHtml(html, { limit = 8 } = {}) {
  const text = String(html || '');
  const anchors = [];
  const anchorRe = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let match;
  while ((match = anchorRe.exec(text)) !== null) {
    anchors.push({ index: match.index, href: match[1], title: stripTags(match[2]) });
  }
  const snippets = [];
  const snippetRe = /<(?:a|td|div)\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)\s*>/gi;
  while ((match = snippetRe.exec(text)) !== null) {
    snippets.push({ index: match.index, body: stripTags(match[1]) });
  }

  const results = [];
  for (let i = 0; i < anchors.length && results.length < limit; i += 1) {
    const anchor = anchors[i];
    const url = decodeDuckDuckGoHref(anchor.href);
    if (!url || !anchor.title) continue;
    const nextIndex = i + 1 < anchors.length ? anchors[i + 1].index : Infinity;
    const snippet = snippets.find((entry) => entry.index > anchor.index && entry.index < nextIndex);
    results.push({ title: anchor.title, url, snippet: snippet?.body || '' });
  }
  return results;
}

async function searchLite({ query, limit, fetchImpl, timeoutMs }) {
  const response = await fetchImpl(`${DDG_LITE_ENDPOINT}?q=${encodeURIComponent(String(query))}`, {
    headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`duckduckgo lite responded with HTTP ${response.status}`);
  }
  return parseDuckDuckGoLiteHtml(await response.text(), { limit });
}

async function searchClassic({ query, limit, fetchImpl, timeoutMs }) {
  const response = await fetchImpl(DDG_HTML_ENDPOINT, {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html'
    },
    body: new URLSearchParams({ q: String(query) }).toString(),
    signal: AbortSignal.timeout(timeoutMs)
  });
  // 202 is DDG's bot-challenge response: technically "ok", zero results.
  if (!response.ok || response.status === 202) {
    throw new Error(`duckduckgo html responded with HTTP ${response.status}`);
  }
  return parseDuckDuckGoHtml(await response.text(), { limit });
}

export async function searchDuckDuckGo({ query, limit = 8, fetchImpl, timeoutMs = 12000 }) {
  let liteError;
  try {
    const results = await searchLite({ query, limit, fetchImpl, timeoutMs });
    if (results.length > 0) return results;
    liteError = new Error('duckduckgo lite returned no results');
  } catch (error) {
    liteError = error;
  }
  try {
    return await searchClassic({ query, limit, fetchImpl, timeoutMs });
  } catch (error) {
    throw new Error(`${String(liteError?.message || liteError)}; ${String(error?.message || error)}`);
  }
}

export default {
  searchDuckDuckGo,
  parseDuckDuckGoHtml,
  parseDuckDuckGoLiteHtml,
  decodeDuckDuckGoHref,
  BROWSER_USER_AGENT
};
