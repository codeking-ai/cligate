// PDF text extraction via pdfjs-dist (pure-JS, no native build — Electron-safe).
// The dependency is loaded with a DYNAMIC import so the rest of the module
// (text/html/OOXML) keeps working even if pdfjs-dist is not installed or fails
// to load: in that case we return a recoverable `extractor_unavailable` result
// instead of throwing at import time and breaking the whole service.

let pdfjsPromise = null;

async function loadPdfjs() {
  if (!pdfjsPromise) {
    // The legacy build is the one intended for Node / non-bundler environments.
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch((error) => {
      pdfjsPromise = null; // allow a later retry once the dep is installed
      throw error;
    });
  }
  return pdfjsPromise;
}

export async function extractPdf(buffer) {
  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch (error) {
    return {
      ok: false,
      kind: 'extractor_unavailable',
      error: `PDF support unavailable (pdfjs-dist not loaded): ${String(error?.message || error)}`
    };
  }

  try {
    const data = new Uint8Array(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
    const loadingTask = pdfjs.getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: true
    });
    const doc = await loadingTask.promise;
    const pages = [];
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      const line = content.items
        .map((item) => (typeof item.str === 'string' ? item.str : '') + (item.hasEOL ? '\n' : ''))
        .join('');
      pages.push(line.trim());
      page.cleanup?.();
    }
    const pageCount = doc.numPages;
    await doc.cleanup?.();
    return { ok: true, pageCount, text: pages.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() };
  } catch (error) {
    return { ok: false, kind: 'extract_failed', error: `failed to parse PDF: ${String(error?.message || error)}` };
  }
}

export default { extractPdf };
