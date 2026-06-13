import { webSearchService, webPageReader } from '../../web-search/index.js';

// Thin adapters between the assistant tool surface and src/web-search/.
// Result `kind` values follow the existing handler convention so the ReAct
// loop can recover (pick another result / engine) instead of dying.
export function createWebToolHandlers({
  searchService = webSearchService,
  pageReader = webPageReader
} = {}) {
  return {
    async webSearch({ input = {} } = {}) {
      const result = await searchService.search({
        query: input.query,
        limit: input.limit,
        engine: input.engine
      });
      if (!result.ok) {
        return {
          kind: 'web_search_failed',
          error: result.error,
          enginesTried: result.enginesTried,
          recoverable: true
        };
      }
      return {
        kind: 'web_search_results',
        query: result.query,
        engine: result.engine,
        fromCache: result.fromCache === true,
        count: result.results.length,
        results: result.results,
        tip: 'Use web_fetch on the most relevant url(s) to read the page before answering. Cite source URLs in your reply.'
      };
    },

    async webFetch({ input = {} } = {}) {
      const result = await pageReader.read({
        url: input.url,
        maxChars: input.maxChars
      });
      if (!result.ok) {
        return {
          kind: result.kind || 'fetch_failed',
          error: result.error,
          recoverable: true
        };
      }
      return {
        kind: 'web_page',
        url: result.url,
        finalUrl: result.finalUrl,
        title: result.title,
        contentType: result.contentType,
        totalChars: result.totalChars,
        truncated: result.truncated,
        text: result.text
      };
    }
  };
}

export default createWebToolHandlers;
