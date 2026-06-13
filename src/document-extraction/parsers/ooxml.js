// OOXML (docx / pptx / xlsx) text extraction — dependency-free. These formats
// are ZIP archives of XML; we unzip the relevant parts (src/document-extraction/
// zip.js) and pull text out with regex, the same pragmatic approach the
// web-search module uses for HTML. Goal: readable, structurally-hinted text for
// the LLM — not a faithful document renderer.

import { readZipDirectory, readZipEntryText } from '../zip.js';
// XML entities are a subset of HTML entities (amp/lt/gt/quot/apos + numeric),
// so the web-search decoder handles them — no second implementation needed.
import { decodeHtmlEntities } from '../../web-search/html-text.js';

const decodeXml = decodeHtmlEntities;

// Collapse runs of spaces within each line while PRESERVING tab separators
// (xlsx rows are tab-delimited); drop trailing blank-line runs.
function tidy(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/[ \t]*\t[ \t]*/g, '\t').replace(/ {2,}/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- DOCX ----------------------------------------------------------------
// Body text lives in <w:t> runs; <w:p> are paragraphs, <w:tab/>/<w:br/> are
// in-run breaks. Convert structure to whitespace, then drop the remaining tags
// (everything textual is inside <w:t>, which survives tag stripping).
export function extractDocx(buffer) {
  const entries = readZipDirectory(buffer);
  const xml = readZipEntryText(buffer, entries, 'word/document.xml');
  if (!xml) return { ok: false, kind: 'extract_failed', error: 'word/document.xml not found' };
  const text = xml
    .replace(/<w:tab\b[^>]*\/?>/gi, '\t')
    .replace(/<w:(?:br|cr)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/w:p>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return { ok: true, text: tidy(decodeXml(text)) };
}

// --- PPTX ----------------------------------------------------------------
// One XML part per slide (ppt/slides/slideN.xml). Text is in <a:t>; <a:p> are
// paragraphs. Emit slides in numeric order with a heading per slide.
// Numeric suffix of an OOXML part name (slide3.xml → 3, sheet12.xml → 12) so
// parts sort in document order rather than lexically (slide2 before slide10).
function partNumber(name) {
  const m = /(\d+)\.xml$/i.exec(name);
  return m ? Number.parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

export function extractPptx(buffer) {
  const entries = readZipDirectory(buffer);
  const slideNames = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => partNumber(a) - partNumber(b));
  if (slideNames.length === 0) return { ok: false, kind: 'extract_failed', error: 'no slides found' };

  const blocks = [];
  slideNames.forEach((name, index) => {
    const xml = readZipEntryText(buffer, entries, name);
    const body = xml
      .replace(/<a:br\b[^>]*\/?>/gi, '\n')
      .replace(/<\/a:p>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    const text = tidy(decodeXml(body));
    blocks.push(`## Slide ${index + 1}\n${text}`.trim());
  });
  return { ok: true, pageCount: slideNames.length, text: blocks.join('\n\n') };
}

// --- XLSX ----------------------------------------------------------------
// Cells reference a shared-strings table (t="s") or carry inline/numeric values.
// Build the shared-strings array, then walk each worksheet's rows/cells in
// document order, emitting tab-separated rows.
function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/gi;
  let m;
  while ((m = siRe.exec(xml))) {
    const inner = m[1];
    const parts = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((x) => x[1]);
    strings.push(decodeXml(parts.join('')));
  }
  return strings;
}

function cellValue(attrs, inner, shared) {
  if (inner == null || inner === '') return '';
  const type = /\bt="([^"]*)"/.exec(attrs)?.[1] || 'n';
  if (type === 's') {
    const idx = Number.parseInt(/<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(inner)?.[1] || '', 10);
    return Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx] : '';
  }
  if (type === 'inlineStr') {
    const parts = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((x) => x[1]);
    return decodeXml(parts.join(''));
  }
  // 'str' (formula result), 'n' (number), 'b' (bool), dates → take <v>.
  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(inner)?.[1] || '';
  return decodeXml(v);
}

function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      cells.push(cellValue(cellMatch[1], cellMatch[2], shared));
    }
    // Trim trailing empties so sparse rows don't emit long tab runs.
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length > 0) rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

export function extractXlsx(buffer) {
  const entries = readZipDirectory(buffer);
  const shared = parseSharedStrings(readZipEntryText(buffer, entries, 'xl/sharedStrings.xml'));
  const sheetNames = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => partNumber(a) - partNumber(b));
  if (sheetNames.length === 0) return { ok: false, kind: 'extract_failed', error: 'no worksheets found' };

  const blocks = [];
  sheetNames.forEach((name, index) => {
    const sheetText = parseSheet(readZipEntryText(buffer, entries, name), shared);
    blocks.push(`## Sheet ${index + 1}\n${tidy(sheetText)}`.trim());
  });
  return { ok: true, pageCount: sheetNames.length, text: blocks.join('\n\n') };
}

export default { extractDocx, extractPptx, extractXlsx };
