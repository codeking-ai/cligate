import { stripTags } from '../html-text.js';
import { BROWSER_USER_AGENT } from './duckduckgo.js';

// Mojeek runs its own independent crawler/index, needs no key, serves plain
// HTML with DIRECT result urls (no redirect wrappers), and was lenient to
// non-browser clients in live probing — which makes it the most honest
// scraped engine in the chain.
const MOJEEK_ENDPOINT = 'https://www.mojeek.com/search';

export function parseMojeekHtml(html, { limit = 8 } = {}) {
  const text = String(html || '');
  const results = [];
  // Each organic result: <h2><a class="title" href="REAL_URL">Title</a></h2>
  // followed by the snippet paragraph <p class="s">…</p>.
  const titleRe = /<h2><a\b[^>]*class="title"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let match;
  while ((match = titleRe.exec(text)) !== null && results.length < limit) {
    const url = String(match[1] || '').trim();
    const title = stripTags(match[2]);
    if (!url.startsWith('http') || !title) continue;
    const tail = text.slice(match.index, match.index + 3000);
    const snippetMatch = /<p class="s">([\s\S]*?)<\/p\s*>/i.exec(tail);
    results.push({ title, url, snippet: snippetMatch ? stripTags(snippetMatch[1]) : '' });
  }
  return results;
}

export async function searchMojeek({ query, limit = 8, fetchImpl, timeoutMs = 12000 }) {
  const response = await fetchImpl(`${MOJEEK_ENDPOINT}?q=${encodeURIComponent(String(query))}`, {
    headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`mojeek responded with HTTP ${response.status}`);
  }
  return parseMojeekHtml(await response.text(), { limit });
}

export default { searchMojeek, parseMojeekHtml };
