// Orchestrator for the document-extraction module. Detects the format, loads
// the bytes (with a size guard), dispatches to the right parser, and applies a
// bounded offset/maxChars window so callers (the read_document tool) can page
// through large documents without ever forcing the whole text into one reply.
//
// Pure module: it does NOT import any route/agent code. Public surface lives in
// ./index.js. Mirrors the shape of src/web-search/page-reader.js.

import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { detectDocumentFormat, isLegacyOfficeFormat, MAX_DOCUMENT_BYTES } from './safety.js';
import { extractTextLike } from './parsers/text.js';
import { extractDocx, extractPptx, extractXlsx } from './parsers/ooxml.js';
import { extractPdf } from './parsers/pdf.js';

const DEFAULT_MAX_CHARS = 20000;
const MIN_MAX_CHARS = 1000;
const MAX_MAX_CHARS = 200000;

function clampMaxChars(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_CHARS;
  return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, parsed));
}

function clampOffset(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export class DocumentExtractor {
  // Returns, on success:
  //   { ok:true, format, name, pageCount?, totalChars, offset, truncated, text }
  // on failure:
  //   { ok:false, kind, error } with kind ∈ unsupported_format | too_large |
  //   extract_failed | extractor_unavailable
  async extract({ filePath = '', buffer = null, mediaType = '', name = '', maxChars, offset } = {}) {
    const effectiveName = String(name || '').trim() || (filePath ? path.basename(filePath) : '');
    const format = detectDocumentFormat(effectiveName, mediaType);
    if (!format) {
      const hint = isLegacyOfficeFormat(effectiveName)
        ? ' Legacy .doc/.ppt/.xls are not supported — re-save as .docx/.pptx/.xlsx.'
        : '';
      return {
        ok: false,
        kind: 'unsupported_format',
        error: `unsupported document type: ${effectiveName || mediaType || 'unknown'}.${hint}`
      };
    }

    let bytes = buffer ? (Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)) : null;
    if (!bytes) {
      if (!filePath) return { ok: false, kind: 'extract_failed', error: 'filePath or buffer is required' };
      let info;
      try {
        info = await stat(filePath);
      } catch (error) {
        return { ok: false, kind: 'extract_failed', error: String(error?.message || error) };
      }
      if (!info.isFile()) return { ok: false, kind: 'extract_failed', error: 'path is not a regular file' };
      if (info.size > MAX_DOCUMENT_BYTES) {
        return { ok: false, kind: 'too_large', error: `file is ${info.size} bytes, exceeds the ${MAX_DOCUMENT_BYTES}-byte limit` };
      }
      try {
        bytes = await readFile(filePath);
      } catch (error) {
        return { ok: false, kind: 'extract_failed', error: String(error?.message || error) };
      }
    } else if (bytes.length > MAX_DOCUMENT_BYTES) {
      return { ok: false, kind: 'too_large', error: `buffer is ${bytes.length} bytes, exceeds the ${MAX_DOCUMENT_BYTES}-byte limit` };
    }

    let parsed;
    try {
      if (format === 'text' || format === 'html') parsed = extractTextLike(bytes, format);
      else if (format === 'docx') parsed = extractDocx(bytes);
      else if (format === 'pptx') parsed = extractPptx(bytes);
      else if (format === 'xlsx') parsed = extractXlsx(bytes);
      else if (format === 'pdf') parsed = await extractPdf(bytes);
      else parsed = { ok: false, kind: 'unsupported_format', error: `no parser for ${format}` };
    } catch (error) {
      parsed = { ok: false, kind: 'extract_failed', error: String(error?.message || error) };
    }
    if (!parsed.ok) {
      return { ok: false, kind: parsed.kind || 'extract_failed', error: parsed.error || 'extraction failed' };
    }

    const fullText = String(parsed.text || '');
    const start = Math.min(clampOffset(offset), fullText.length);
    const limit = clampMaxChars(maxChars);
    const end = start + limit;
    const window = fullText.slice(start, end);
    const truncated = fullText.length > end;
    const text = truncated
      ? `${window}\n\n[document truncated at ${end}/${fullText.length} chars — call read_document again with offset=${end} to continue]`
      : window;

    return {
      ok: true,
      format,
      name: effectiveName,
      ...(Number.isFinite(parsed.pageCount) ? { pageCount: parsed.pageCount } : {}),
      totalChars: fullText.length,
      offset: start,
      truncated,
      text
    };
  }
}

export const documentExtractor = new DocumentExtractor();

export default documentExtractor;
