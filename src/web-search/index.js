// Public surface of the web-search module. Everything the rest of the app
// needs lives here; the engine/parser internals stay private to this
// directory. See docs/web-search-design.md for goals and architecture.
export { WebSearchService, webSearchService } from './search-service.js';
export { WebPageReader, webPageReader } from './page-reader.js';
export { validateOutboundUrl, isPrivateHost } from './safety.js';
export { htmlToText, extractTitle } from './html-text.js';
