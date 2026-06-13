// Plain-text and HTML extraction. Text formats (md/txt/csv/json/…) are returned
// as-is; HTML reuses the dependency-free converter from the web-search module so
// we don't ship a second HTML→text implementation.

import { htmlToText } from '../../web-search/html-text.js';

// Strip a UTF-8 BOM if present so the first line isn't polluted.
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function extractTextLike(buffer, format = 'text') {
  const raw = stripBom(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || ''));
  if (format === 'html') {
    return { ok: true, text: htmlToText(raw) };
  }
  return { ok: true, text: raw };
}

export default { extractTextLike };
