import { searchDuckDuckGo } from './engines/duckduckgo.js';
import { searchBing } from './engines/bing.js';
import { searchSearxng } from './engines/searxng.js';
import { searchMojeek } from './engines/mojeek.js';
import { searchBaidu } from './engines/baidu.js';

const KNOWN_ENGINES = ['searxng', 'duckduckgo', 'mojeek', 'baidu', 'bing'];
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

function clampLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, parsed));
}

function hasCjk(text) {
  return /[぀-ヿ㐀-鿿豈-﫿]/.test(String(text || ''));
}

function registrableDomain(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split('.');
    return parts.length <= 2 ? host : parts.slice(-2).join('.');
  } catch {
    return '';
  }
}

function dedupeResults(results) {
  const seen = new Set();
  const deduped = [];
  for (const entry of results) {
    let key = entry.url;
    try {
      const parsed = new URL(entry.url);
      key = `${parsed.hostname}${parsed.pathname}`.toLowerCase().replace(/\/+$/, '');
    } catch {
      // keep the raw URL as the key
    }
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

// Bing answers bot-suspicious traffic with DECOY results — a plausible-looking
// SERP whose entries all point at one unrelated site (observed live:
// "Node.js 24 release notes" → five weworkremotely.com job pages) instead of
// an honest 403. A poisoned "success" would stop the fallback chain and feed
// the LLM garbage sources, so: if every result shares one registrable domain
// that the query never mentions, treat the response as a decoy and fall
// through to the next engine.
function looksLikeDecoySerp(results, query) {
  if (results.length < 3) return false;
  const domains = new Set(results.map((entry) => registrableDomain(entry.url)).filter(Boolean));
  if (domains.size !== 1) return false;
  const [domain] = domains;
  const bareName = domain.split('.')[0];
  const normalizedQuery = String(query || '').toLowerCase();
  return !normalizedQuery.includes(domain) && !normalizedQuery.includes(bareName);
}

export class WebSearchService {
  constructor({ fetchImpl = globalThis.fetch.bind(globalThis), env = process.env } = {}) {
    this.fetchImpl = fetchImpl;
    this.env = env;
    this.cache = new Map();
  }

  searxngBaseUrl() {
    return String(this.env.CLIGATE_SEARXNG_URL || '').trim();
  }

  timeoutMs() {
    const parsed = Number.parseInt(String(this.env.CLIGATE_WEB_SEARCH_TIMEOUT_MS || ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 12000;
  }

  // CSV override via CLIGATE_WEB_SEARCH_ENGINES; otherwise searxng (when
  // configured) first, then keyless engines ordered by query language: Baidu
  // leads for CJK queries (best Chinese index, reachable on CN networks),
  // DuckDuckGo-lite + Mojeek lead otherwise. Bing always goes last — its
  // anti-bot decoy pages make it the least trustworthy source (see
  // looksLikeDecoySerp). Unknown names are ignored.
  resolveEngineOrder(requestedEngine = '', query = '') {
    const requested = String(requestedEngine || '').trim().toLowerCase();
    if (requested) {
      return KNOWN_ENGINES.includes(requested) ? [requested] : [];
    }
    const override = String(this.env.CLIGATE_WEB_SEARCH_ENGINES || '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => KNOWN_ENGINES.includes(name));
    if (override.length > 0) return [...new Set(override)];
    const order = hasCjk(query)
      ? ['baidu', 'duckduckgo', 'mojeek', 'bing']
      : ['duckduckgo', 'mojeek', 'baidu', 'bing'];
    if (this.searxngBaseUrl()) order.unshift('searxng');
    return order;
  }

  async runEngine(name, { query, limit }) {
    const common = { query, limit, fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs() };
    if (name === 'duckduckgo') return searchDuckDuckGo(common);
    if (name === 'mojeek') return searchMojeek(common);
    if (name === 'baidu') return searchBaidu(common);
    if (name === 'bing') return searchBing(common);
    if (name === 'searxng') return searchSearxng({ ...common, baseUrl: this.searxngBaseUrl() });
    throw new Error(`unknown search engine "${name}"`);
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

  // Returns { ok: true, query, engine, results, fromCache }
  //      or { ok: false, error, enginesTried }.
  async search({ query, limit, engine = '' } = {}) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return { ok: false, error: 'query is required', enginesTried: [] };
    }
    const effectiveLimit = clampLimit(limit);
    const order = this.resolveEngineOrder(engine, normalizedQuery);
    if (order.length === 0) {
      return {
        ok: false,
        error: `unknown engine "${engine}" (known: ${KNOWN_ENGINES.join(', ')})`,
        enginesTried: []
      };
    }

    const cacheKey = `${order.join('+')}|${effectiveLimit}|${normalizedQuery.toLowerCase()}`;
    const cached = this.cacheGet(cacheKey);
    if (cached) {
      return { ...cached, fromCache: true };
    }

    const errors = [];
    for (const name of order) {
      let results;
      try {
        results = await this.runEngine(name, { query: normalizedQuery, limit: effectiveLimit });
      } catch (error) {
        errors.push(`${name}: ${String(error?.message || error)}`);
        continue;
      }
      const cleaned = dedupeResults(
        (Array.isArray(results) ? results : [])
          .map((entry) => ({
            title: String(entry?.title || '').trim().slice(0, 300),
            url: String(entry?.url || '').trim(),
            snippet: String(entry?.snippet || '').trim().slice(0, 500)
          }))
          .filter((entry) => entry.title && entry.url.startsWith('http'))
      ).slice(0, effectiveLimit)
        .map((entry, index) => ({ position: index + 1, ...entry }));
      if (cleaned.length === 0) {
        errors.push(`${name}: returned no results`);
        continue;
      }
      if (looksLikeDecoySerp(cleaned, normalizedQuery)) {
        errors.push(`${name}: served a suspected anti-bot decoy page (all ${cleaned.length} results point at one unrelated site)`);
        continue;
      }
      const value = { ok: true, query: normalizedQuery, engine: name, results: cleaned, fromCache: false };
      this.cacheSet(cacheKey, value);
      return value;
    }

    return {
      ok: false,
      error: `all engines failed — ${errors.join('; ')}`,
      enginesTried: order
    };
  }
}

export const webSearchService = new WebSearchService();

export default webSearchService;
