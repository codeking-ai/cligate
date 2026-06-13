// Dependency-free HTML → readable-text conversion for LLM consumption.
// Deliberately NOT a DOM-perfect renderer: the goal is compact, structurally
// hinted text (headings, list bullets, markdown links) that survives regex
// parsing of real-world pages without pulling in turndown/readability.

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  bull: '•'
};

export function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_match, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

export function stripTags(html) {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function resolveHref(href, baseUrl) {
  const raw = decodeHtmlEntities(String(href || '').trim());
  if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('data:')) return '';
  try {
    const resolved = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    return (resolved.protocol === 'http:' || resolved.protocol === 'https:') ? resolved.href : '';
  } catch {
    return '';
  }
}

export function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return match ? stripTags(match[1]).slice(0, 300) : '';
}

// Convert an HTML document (or fragment) into readable text.
// options.baseUrl resolves relative links; options.keepLinks controls whether
// anchors render as [text](url) (default true).
export function htmlToText(html, { baseUrl = '', keepLinks = true } = {}) {
  let text = String(html || '');

  // Drop content-free containers entirely (scripts, styles, embedded svg…).
  text = text.replace(/<(script|style|noscript|template|svg|iframe|head|object|embed)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');

  // Anchors → markdown links (before generic tag stripping eats the hrefs).
  text = text.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_match, href, inner) => {
    const label = stripTags(inner);
    if (!label) return ' ';
    if (!keepLinks) return ` ${label} `;
    const resolved = resolveHref(href, baseUrl);
    return resolved ? ` [${label}](${resolved}) ` : ` ${label} `;
  });

  // Structural hints.
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_match, level, inner) => {
    const label = stripTags(inner);
    return label ? `\n\n${'#'.repeat(Number(level))} ${label}\n\n` : '\n';
  });
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  text = text.replace(/<(?:td|th)\b[^>]*>/gi, ' | ');
  text = text.replace(/<(?:br|hr)\b[^>]*\/?>/gi, '\n');
  text = text.replace(/<\/(?:p|div|section|article|tr|table|ul|ol|blockquote|pre|figure|header|footer|main|aside|nav|form|fieldset|dl|dd|dt)\s*>/gi, '\n');

  // Everything else loses its tags.
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeHtmlEntities(text);

  // Whitespace discipline: collapse runs, keep at most one blank line.
  text = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').replace(/^\s*\|\s*/, '').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

export default { htmlToText, stripTags, decodeHtmlEntities, extractTitle };
