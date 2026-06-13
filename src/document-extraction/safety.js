// Format detection + guards for the document-extraction module. Mirrors the
// role of src/web-search/safety.js: vet inputs before any parsing work runs.
// Detection is extension-first (the most reliable signal for local files),
// with MIME as a fallback. Returns one of the canonical format keys below or
// '' when the type is not something we can extract.

import path from 'node:path';

// Hard ceiling on a single document we will load into memory to extract. PDFs
// and OOXML must be read whole; text is read whole too. 25MB is generous for
// real documents while keeping the Node process memory bounded.
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

// extension (no dot, lowercase) → canonical format key.
const EXTENSION_FORMATS = {
  // plain-text family — read as UTF-8 verbatim
  txt: 'text',
  text: 'text',
  md: 'text',
  markdown: 'text',
  mdown: 'text',
  csv: 'text',
  tsv: 'text',
  json: 'text',
  jsonl: 'text',
  log: 'text',
  xml: 'text',
  yaml: 'text',
  yml: 'text',
  ini: 'text',
  conf: 'text',
  // html family — converted via web-search/html-text.js
  html: 'html',
  htm: 'html',
  // OOXML (ZIP-of-XML) — zero-dependency unzip + regex
  docx: 'docx',
  pptx: 'pptx',
  xlsx: 'xlsx',
  // portable document — pure-JS lib (dynamic import)
  pdf: 'pdf'
};

// MIME → canonical format key (fallback when extension is missing/unknown).
const MIME_FORMATS = {
  'text/plain': 'text',
  'text/markdown': 'text',
  'text/csv': 'text',
  'text/tab-separated-values': 'text',
  'application/json': 'text',
  'application/xml': 'text',
  'text/xml': 'text',
  'application/x-yaml': 'text',
  'text/yaml': 'text',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/pdf': 'pdf'
};

// Legacy OLE compound formats we explicitly cannot handle dependency-free.
const LEGACY_OFFICE_EXTENSIONS = new Set(['doc', 'ppt', 'xls']);

export function extensionOf(name = '') {
  const ext = path.extname(String(name || '')).replace(/^\./, '').toLowerCase();
  return ext;
}

// Returns a canonical format key ('text'|'html'|'docx'|'pptx'|'xlsx'|'pdf')
// or '' when unsupported. `mediaType` may carry a charset suffix.
export function detectDocumentFormat(name = '', mediaType = '') {
  const ext = extensionOf(name);
  if (ext && EXTENSION_FORMATS[ext]) return EXTENSION_FORMATS[ext];
  const mime = String(mediaType || '').split(';')[0].trim().toLowerCase();
  if (mime && MIME_FORMATS[mime]) return MIME_FORMATS[mime];
  // text/* with an unknown subtype is still readable as text.
  if (mime.startsWith('text/')) return 'text';
  return '';
}

export function isLegacyOfficeFormat(name = '') {
  return LEGACY_OFFICE_EXTENSIONS.has(extensionOf(name));
}

export function isSupportedDocument(name = '', mediaType = '') {
  return detectDocumentFormat(name, mediaType) !== '';
}

export default { MAX_DOCUMENT_BYTES, detectDocumentFormat, isLegacyOfficeFormat, isSupportedDocument, extensionOf };
