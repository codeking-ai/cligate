import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDuckDuckGoHtml, parseDuckDuckGoLiteHtml, decodeDuckDuckGoHref } from '../../src/web-search/engines/duckduckgo.js';
import { parseBingHtml, decodeBingHref } from '../../src/web-search/engines/bing.js';
import { searchSearxng } from '../../src/web-search/engines/searxng.js';
import { parseMojeekHtml } from '../../src/web-search/engines/mojeek.js';
import { parseBaiduHtml, searchBaidu, resetBaiduCookieCache } from '../../src/web-search/engines/baidu.js';
import { WebSearchService } from '../../src/web-search/search-service.js';
import { WebPageReader } from '../../src/web-search/page-reader.js';
import { validateOutboundUrl, isPrivateHost } from '../../src/web-search/safety.js';
import { htmlToText, extractTitle, decodeHtmlEntities } from '../../src/web-search/html-text.js';
import createWebToolHandlers from '../../src/assistant-tools/handlers/web.js';
import { AssistantToolsRegistry } from '../../src/assistant-tools/registry.js';
import { AssistantToolsExecutor } from '../../src/assistant-tools/executor.js';
import { AssistantToolPolicyService } from '../../src/assistant-tools/policy.js';
import createWebSearchToolDefinition from '../../src/assistant-tools/definitions/web-search.js';
import createWebFetchToolDefinition from '../../src/assistant-tools/definitions/web-fetch.js';

// --- fixtures ----------------------------------------------------------------

const DDG_HTML = `
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fblog%2Frelease&amp;rut=abc">Node.js — Releases</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fblog%2Frelease&amp;rut=abc">Latest <b>Node.js</b> release notes and schedule.</a>
  </div>
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://github.com/nodejs/node/releases">nodejs/node releases · GitHub</a>
    </h2>
    <a class="result__snippet" href="https://github.com/nodejs/node/releases">Release assets for Node.js.</a>
  </div>
  <div class="result result--ad">
    <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example&u3=enc">Sponsored thing</a>
  </div>
</div>`;

// Mirrors the real 2026 SERP shape: a "tilk" site anchor BEFORE the h2, the
// real URL base64url-wrapped in a /ck/a redirect, and nested <li> inside the
// block (which breaks lazy …</li> matching).
const BING_HTML = `
<ol id="b_results">
  <li class="b_algo" data-id iid="SERP.5340">
    <div class="b_tpcn"><a class="tilk" href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=a1aHR0cHM6Ly9ub2RlanMub3JnL2Vu&amp;ntb=1">nodejs.org</a></div>
    <h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=a1aHR0cHM6Ly9ub2RlanMub3JnL2Vu&amp;ntb=1">Node.js — Run JavaScript Everywhere</a></h2>
    <div class="b_caption"><p>Node.js® is a free, open-source, cross-platform JavaScript runtime…</p></div>
    <ul class="b_deep"><li><a href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9ub2RlanMub3JnL2VuL2Rvd25sb2Fk&amp;ntb=1">Download</a></li></ul>
  </li>
  <li class="b_algo">
    <h2><a href="https://en.wikipedia.org/wiki/Node.js">Node.js - Wikipedia</a></h2>
    <div class="b_caption"><p>Node.js is a cross-platform, open-source JavaScript runtime environment.</p></div>
  </li>
  <li class="b_ad"><h2><a href="https://ads.example.com">Buy node now</a></h2></li>
</ol>`;

// Mirrors the real lite.duckduckgo.com table layout (href before class,
// single-quoted class, uddg redirect wrappers).
const DDG_LITE_HTML = `
<table>
  <tr><td>1.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fblog%2Frelease%2Fv24.0.0&amp;rut=33e4" class='result-link'>Node v24.0.0 (Current)</a></td></tr>
  <tr><td></td><td class='result-snippet'>2025-05-06, Version 24.0.0 (Current), @RafaelGSS</td></tr>
  <tr><td>2.&nbsp;</td><td><a rel="nofollow" href="https://github.com/nodejs/node/releases" class='result-link'>nodejs/node releases</a></td></tr>
  <tr><td></td><td class='result-snippet'>Release assets for Node.js.</td></tr>
</table>`;

const MOJEEK_HTML = `
<ul class="results-standard">
  <li class="r1"><a title="x" href="https://nodejs.org/en/blog" class="ob"><p class="i"><span class="url">nodejs.org</span></p></a>
    <h2><a class="title" title="x" href="https://nodejs.org/en/blog">Node.js Blog</a></h2>
    <p class="s">Official <strong>Node</strong>.<strong>js</strong> news and releases.</p></li>
  <li class="r2">
    <h2><a class="title" title="y" href="https://en.wikipedia.org/wiki/Node.js">Node.js - Wikipedia</a></h2>
    <p class="s">Cross-platform JavaScript runtime.</p></li>
</ul>`;

const BAIDU_HTML = `<!DOCTYPE html><html><body><div id="content_left">
  <div class="result c-container xpath-log new-pmd" srcid="1599" mu="https://nodejs.org/zh-cn">
    <h3 class="c-title t t-tts"><a href="http://www.baidu.com/link?url=ABC123">Node.js 中文网</a></h3>
    <span class="content-right_2s-H4">Node.js® 是一个免费、开源、跨平台的 JavaScript 运行时环境。</span>
  </div>
  <div class="result c-container xpath-log new-pmd" srcid="1599">
    <h3 class="c-title"><a href="http://www.baidu.com/link?url=DEF456">没有 mu 的结果</a></h3>
    <div class="c-abstract">摘要内容。</div>
  </div>
</div>${'<!-- padding -->'.repeat(800)}</body></html>`;

function fakeResponse({ status = 200, body = '', contentType = 'text/html', url = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer
  };
}

// --- engine parsers ----------------------------------------------------------

test('duckduckgo parser decodes uddg redirects, pairs snippets, skips ads', () => {
  const results = parseDuckDuckGoHtml(DDG_HTML, { limit: 8 });
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://nodejs.org/en/blog/release');
  assert.equal(results[0].title, 'Node.js — Releases');
  assert.match(results[0].snippet, /release notes/);
  assert.equal(results[1].url, 'https://github.com/nodejs/node/releases');
});

test('duckduckgo href decoding handles plain, protocol-relative, and ad urls', () => {
  assert.equal(decodeDuckDuckGoHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(decodeDuckDuckGoHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.dev%2Fp%3Fq%3D1&rut=z'), 'https://x.dev/p?q=1');
  assert.equal(decodeDuckDuckGoHref('https://duckduckgo.com/y.js?ad_domain=ads.example'), '');
});

test('bing parser extracts b_algo blocks, decodes ck/a redirects, ignores ads', () => {
  const results = parseBingHtml(BING_HTML, { limit: 8 });
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://nodejs.org/en');
  assert.equal(results[0].title, 'Node.js — Run JavaScript Everywhere');
  assert.match(results[0].snippet, /JavaScript runtime/);
  assert.equal(results[1].url, 'https://en.wikipedia.org/wiki/Node.js');
});

test('bing href decoding: ck/a base64url, plain urls, garbage', () => {
  assert.equal(
    decodeBingHref('https://www.bing.com/ck/a?!&&p=x&u=a1aHR0cHM6Ly9ub2RlanMub3JnL2VuL2Rvd25sb2Fk&ntb=1'),
    'https://nodejs.org/en/download'
  );
  assert.equal(decodeBingHref('https://example.com/direct'), 'https://example.com/direct');
  assert.equal(decodeBingHref('https://www.bing.com/ck/a?ntb=1'), '');
  assert.equal(decodeBingHref('/relative/path'), '');
});

test('duckduckgo LITE parser pairs links with snippets and decodes redirects', () => {
  const results = parseDuckDuckGoLiteHtml(DDG_LITE_HTML, { limit: 8 });
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://nodejs.org/en/blog/release/v24.0.0');
  assert.equal(results[0].title, 'Node v24.0.0 (Current)');
  assert.match(results[0].snippet, /Version 24\.0\.0/);
  assert.equal(results[1].url, 'https://github.com/nodejs/node/releases');
});

test('mojeek parser extracts titles, direct urls, and snippets', () => {
  const results = parseMojeekHtml(MOJEEK_HTML, { limit: 8 });
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://nodejs.org/en/blog');
  assert.equal(results[0].title, 'Node.js Blog');
  assert.match(results[0].snippet, /news and releases/);
});

test('baidu parser prefers the mu attribute over the /link redirect', () => {
  const results = parseBaiduHtml(BAIDU_HTML, { limit: 8 });
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://nodejs.org/zh-cn');
  assert.equal(results[0].title, 'Node.js 中文网');
  assert.match(results[0].snippet, /JavaScript 运行时/);
  assert.equal(results[1].url, 'http://www.baidu.com/link?url=DEF456', 'falls back to the redirect url');
  assert.match(results[1].snippet, /摘要内容/);
});

test('baidu engine bootstraps a cookie and rejects the JS shell page', async () => {
  resetBaiduCookieCache();
  const calls = [];
  const shellFetch = async (url, options = {}) => {
    calls.push({ url: String(url), cookie: options.headers?.Cookie || '' });
    if (String(url) === 'https://www.baidu.com/') {
      return {
        ...fakeResponse({ body: 'home' }),
        headers: {
          get: () => null,
          getSetCookie: () => ['BAIDUID=ABCD1234:FG=1; expires=…; path=/', 'H_PS_PSSID=x; path=/']
        }
      };
    }
    return fakeResponse({ body: '<html>tiny js shell</html>', url });
  };
  await assert.rejects(
    () => searchBaidu({ query: 'node', limit: 5, fetchImpl: shellFetch }),
    /JS shell/
  );
  assert.equal(calls[0].url, 'https://www.baidu.com/');
  assert.match(calls[1].cookie, /^BAIDUID=ABCD1234:FG=1$/);
  resetBaiduCookieCache();
});

test('searxng engine parses the JSON API shape', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /^https:\/\/searx\.example\/search\?q=node\.js&format=json$/);
    return fakeResponse({
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          { title: 'Node.js', url: 'https://nodejs.org', content: 'runtime' },
          { title: 'no url entry', url: '', content: 'dropped' }
        ]
      })
    });
  };
  const results = await searchSearxng({ query: 'node.js', limit: 5, baseUrl: 'https://searx.example/', fetchImpl });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { title: 'Node.js', url: 'https://nodejs.org', snippet: 'runtime' });
});

// --- search service ----------------------------------------------------------

test('search service falls back to the next engine when the first fails, and caches', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (String(url).includes('duckduckgo')) return fakeResponse({ status: 503 });
    return fakeResponse({ body: BING_HTML });
  };
  const service = new WebSearchService({ fetchImpl, env: {} });

  const first = await service.search({ query: 'Node.js', limit: 5 });
  assert.equal(first.ok, true);
  assert.equal(first.engine, 'bing');
  assert.equal(first.fromCache, false);
  assert.equal(first.results[0].position, 1);

  const second = await service.search({ query: 'node.js', limit: 5 });
  assert.equal(second.fromCache, true, 'case-insensitive repeat query must hit the cache');
  assert.equal(calls.filter((u) => String(u).includes('bing')).length, 1);
});

test('search service reports all-engines-failed with per-engine reasons', async () => {
  resetBaiduCookieCache();
  const service = new WebSearchService({ fetchImpl: async () => fakeResponse({ status: 429 }), env: {} });
  const result = await service.search({ query: 'anything' });
  assert.equal(result.ok, false);
  assert.match(result.error, /duckduckgo: .*429/);
  assert.match(result.error, /bing: .*429/);
  assert.deepEqual(result.enginesTried, ['duckduckgo', 'mojeek', 'baidu', 'bing']);
});

test('search service engine order: CJK puts baidu first, searxng leads when configured, env csv wins', () => {
  const noSearx = new WebSearchService({ env: {} });
  assert.deepEqual(noSearx.resolveEngineOrder('', 'node.js docs'), ['duckduckgo', 'mojeek', 'baidu', 'bing']);
  assert.deepEqual(noSearx.resolveEngineOrder('', '深圳明天天气'), ['baidu', 'duckduckgo', 'mojeek', 'bing']);

  const withSearx = new WebSearchService({ env: { CLIGATE_SEARXNG_URL: 'https://searx.example' } });
  assert.deepEqual(withSearx.resolveEngineOrder('', 'node.js docs'), ['searxng', 'duckduckgo', 'mojeek', 'baidu', 'bing']);

  const withOverride = new WebSearchService({ env: { CLIGATE_WEB_SEARCH_ENGINES: 'bing, duckduckgo, nope' } });
  assert.deepEqual(withOverride.resolveEngineOrder('', '深圳天气'), ['bing', 'duckduckgo']);

  assert.deepEqual(noSearx.resolveEngineOrder('bing'), ['bing']);
  assert.deepEqual(noSearx.resolveEngineOrder('google'), []);
});

test('search service rejects anti-bot decoy SERPs (all results on one unrelated domain)', async () => {
  // The live incident: Bing answered "Node.js 24 release notes" with five
  // weworkremotely.com job pages instead of an honest 403.
  const decoyHtml = [1, 2, 3, 4, 5].map((i) => `
    <li class="b_algo"><h2><a href="https://weworkremotely.com/page-${i}">Remote job ${i}</a></h2><p>job</p></li>`).join('');
  const service = new WebSearchService({
    fetchImpl: async (url) => (String(url).includes('bing.com/search') ? fakeResponse({ body: decoyHtml }) : fakeResponse({ status: 503 })),
    env: { CLIGATE_WEB_SEARCH_ENGINES: 'bing' }
  });
  const result = await service.search({ query: 'Node.js 24 release notes' });
  assert.equal(result.ok, false);
  assert.match(result.error, /decoy/);

  // …but a homogeneous SERP is legitimate when the query names that site.
  const siteService = new WebSearchService({
    fetchImpl: async () => fakeResponse({ body: decoyHtml }),
    env: { CLIGATE_WEB_SEARCH_ENGINES: 'bing' }
  });
  const siteResult = await siteService.search({ query: 'site:weworkremotely.com node jobs' });
  assert.equal(siteResult.ok, true);
});

test('search service dedupes results by host+path across trailing slashes', async () => {
  const html = `
    <li class="b_algo"><h2><a href="https://x.dev/docs">Docs</a></h2><p>a</p></li>
    <li class="b_algo"><h2><a href="https://x.dev/docs/">Docs again</a></h2><p>b</p></li>`;
  const service = new WebSearchService({
    fetchImpl: async (url) => (String(url).includes('bing') ? fakeResponse({ body: html }) : fakeResponse({ status: 500 })),
    env: {}
  });
  const result = await service.search({ query: 'docs' });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
});

// --- html-to-text ------------------------------------------------------------

test('htmlToText drops scripts, keeps headings/lists/links, decodes entities', () => {
  const html = `
    <html><head><title>T</title><style>.x{}</style><script>var a=1;</script></head>
    <body>
      <h1>Main &amp; Title</h1>
      <p>Hello&nbsp;world</p>
      <ul><li>first</li><li>second</li></ul>
      <a href="/docs">Relative docs</a>
      <a href="javascript:void(0)">js link</a>
    </body></html>`;
  const text = htmlToText(html, { baseUrl: 'https://x.dev/page' });
  assert.match(text, /# Main & Title/);
  assert.match(text, /Hello world/);
  assert.match(text, /- first\n- second/);
  assert.match(text, /\[Relative docs\]\(https:\/\/x\.dev\/docs\)/);
  assert.ok(!text.includes('var a=1'));
  assert.ok(!text.includes('javascript:'));
});

test('extractTitle and entity decoding', () => {
  assert.equal(extractTitle('<title>A &amp; B</title>'), 'A & B');
  assert.equal(decodeHtmlEntities('&#x4e2d;&#25991; &quot;q&quot;'), '中文 "q"');
});

// --- safety ------------------------------------------------------------------

test('outbound URL guard blocks private hosts, bad schemes, and credentials', () => {
  assert.equal(validateOutboundUrl('https://example.com/x').ok, true);
  for (const bad of [
    'http://localhost:8081/api',
    'http://127.0.0.1/',
    'https://192.168.1.10/admin',
    'https://10.0.0.5/x',
    'https://172.16.3.4/',
    'https://169.254.169.254/latest/meta-data',
    'https://router.local/',
    'https://[::1]/',
    'ftp://example.com/file',
    'https://user:pass@example.com/'
  ]) {
    assert.equal(validateOutboundUrl(bad).ok, false, `${bad} must be rejected`);
  }
  assert.equal(isPrivateHost('example.com'), false);
});

// --- page reader -------------------------------------------------------------

test('page reader extracts readable text, reports truncation, and caches', async () => {
  let fetchCount = 0;
  const body = `<html><head><title>Doc</title></head><body><h1>Header</h1><p>${'lorem '.repeat(400)}</p></body></html>`;
  const reader = new WebPageReader({
    fetchImpl: async (url) => {
      fetchCount += 1;
      return fakeResponse({ body, url });
    },
    env: {}
  });

  const result = await reader.read({ url: 'https://docs.example.com/page', maxChars: 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.title, 'Doc');
  assert.equal(result.truncated, true);
  assert.match(result.text, /\[content truncated at 1000 chars\]/);
  assert.match(result.text, /# Header/);

  await reader.read({ url: 'https://docs.example.com/page', maxChars: 1000 });
  assert.equal(fetchCount, 1, 'second read must come from cache');
});

test('page reader upgrades http to https and falls back to http when https fails', async () => {
  const attempts = [];
  const reader = new WebPageReader({
    fetchImpl: async (url) => {
      attempts.push(String(url));
      if (String(url).startsWith('https:')) throw new Error('TLS handshake failed');
      return fakeResponse({ body: '<title>plain http</title>ok', url });
    },
    env: {}
  });
  const result = await reader.read({ url: 'http://old-site.example.com/' });
  assert.equal(result.ok, true);
  assert.equal(attempts[0], 'https://old-site.example.com/');
  assert.equal(attempts[1], 'http://old-site.example.com/');
});

test('page reader refuses binary content and private urls', async () => {
  const reader = new WebPageReader({
    fetchImpl: async (url) => fakeResponse({ contentType: 'application/pdf', body: 'x', url }),
    env: {}
  });
  const binary = await reader.read({ url: 'https://example.com/file.pdf' });
  assert.equal(binary.ok, false);
  assert.equal(binary.kind, 'unsupported_content');

  const ssrf = await reader.read({ url: 'http://127.0.0.1:8081/api/accounts' });
  assert.equal(ssrf.ok, false);
  assert.equal(ssrf.kind, 'invalid_url');
});

// --- assistant tool surface (end-to-end through registry/executor/policy) -----

function buildWebToolExecutor({ searchService, pageReader }) {
  const handlers = createWebToolHandlers({ searchService, pageReader });
  const registry = new AssistantToolsRegistry();
  registry.register(createWebSearchToolDefinition({ handlers }));
  registry.register(createWebFetchToolDefinition({ handlers }));
  return new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: new AssistantToolPolicyService()
  });
}

test('web_search executes through the executor without approval and returns result blocks', async () => {
  const searchService = new WebSearchService({
    fetchImpl: async (url) => (String(url).includes('duckduckgo') ? fakeResponse({ body: DDG_HTML }) : fakeResponse({ status: 500 })),
    env: {}
  });
  const executor = buildWebToolExecutor({ searchService, pageReader: new WebPageReader({ env: {} }) });

  const result = await executor.executeToolCall(
    { toolName: 'web_search', input: { query: 'node.js releases' } },
    { cwd: process.cwd() }
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.structured.kind, 'web_search_results');
  assert.equal(result.structured.engine, 'duckduckgo');
  assert.equal(result.structured.results.length, 2);
  assert.match(result.structured.tip, /web_fetch/);
});

test('web_fetch executes through the executor and surfaces recoverable failures', async () => {
  const pageReader = new WebPageReader({
    fetchImpl: async (url) => fakeResponse({ body: '<title>Hi</title><p>content</p>', url }),
    env: {}
  });
  const executor = buildWebToolExecutor({
    searchService: new WebSearchService({ env: {} }),
    pageReader
  });

  const ok = await executor.executeToolCall(
    { toolName: 'web_fetch', input: { url: 'https://example.com/' } },
    { cwd: process.cwd() }
  );
  assert.equal(ok.status, 'completed');
  assert.equal(ok.structured.kind, 'web_page');
  assert.equal(ok.structured.title, 'Hi');

  const blocked = await executor.executeToolCall(
    { toolName: 'web_fetch', input: { url: 'http://localhost/secret' } },
    { cwd: process.cwd() }
  );
  assert.equal(blocked.status, 'completed', 'guard failures are structured results, not crashes');
  assert.equal(blocked.structured.kind, 'invalid_url');
  assert.equal(blocked.structured.recoverable, true);
});

test('web tools are registered as read-only and parallel safe', () => {
  const handlers = createWebToolHandlers({});
  for (const definition of [createWebSearchToolDefinition({ handlers }), createWebFetchToolDefinition({ handlers })]) {
    assert.equal(definition.mutating, false);
    assert.equal(definition.requiresApproval, false);
    assert.equal(definition.parallelSafe, true);
    assert.equal(typeof definition.execute, 'function');
  }
});
