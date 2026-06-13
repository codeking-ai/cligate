// Public surface of the document-extraction module. Everything the rest of the
// app needs lives here; the parser/zip internals stay private to this directory.
// See docs/file-attachment-design.zh-CN.md for goals and architecture.
//
// Mirrors src/web-search/index.js: a single orchestrator + a few leaf helpers.
export { DocumentExtractor, documentExtractor } from './extractor.js';
export {
  detectDocumentFormat,
  isSupportedDocument,
  isLegacyOfficeFormat,
  extensionOf,
  MAX_DOCUMENT_BYTES
} from './safety.js';
