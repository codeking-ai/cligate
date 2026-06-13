import { BROWSER_USER_AGENT } from './duckduckgo.js';

// Optional engine for operators who run (or trust) a SearXNG instance —
// free, self-hosted meta-search with a stable JSON API. Enabled only when
// CLIGATE_SEARXNG_URL is set; when configured it is tried first because JSON
// parsing beats SERP scraping for reliability.
export async function searchSearxng({ query, limit = 8, baseUrl, fetchImpl, timeoutMs = 12000 }) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) {
    throw new Error('searxng engine requires CLIGATE_SEARXNG_URL');
  }
  const url = `${base}/search?q=${encodeURIComponent(String(query))}&format=json`;
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`searxng responded with HTTP ${response.status}`);
  }
  const payload = await response.json();
  const entries = Array.isArray(payload?.results) ? payload.results : [];
  return entries
    .map((entry) => ({
      title: String(entry?.title || '').trim(),
      url: String(entry?.url || '').trim(),
      snippet: String(entry?.content || '').trim()
    }))
    .filter((entry) => entry.title && entry.url.startsWith('http'))
    .slice(0, limit);
}

export default { searchSearxng };
