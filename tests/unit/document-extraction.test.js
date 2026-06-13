import { test } from 'node:test';
import assert from 'node:assert/strict';

import { documentExtractor } from '../../src/document-extraction/index.js';
import { detectDocumentFormat, isSupportedDocument } from '../../src/document-extraction/safety.js';
import { readZipDirectory, readZipEntryText } from '../../src/document-extraction/zip.js';

// Build a minimal ZIP using STORED (method 0) entries so the test needs no
// compression — exercises the central-directory reader end to end. Real Office
// files use deflate, but the reader path (CD → local header → data) is shared.
function buildStoredZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, content } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dataBuf = Buffer.from(content, 'utf8');
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 8); // method = stored
    lfh.writeUInt32LE(0, 14); // crc32 (unchecked by reader)
    lfh.writeUInt32LE(dataBuf.length, 18); // compressed size
    lfh.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra length
    const localRecord = Buffer.concat([lfh, nameBuf, dataBuf]);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0, 10); // method = stored
    cdh.writeUInt32LE(0, 16); // crc32
    cdh.writeUInt32LE(dataBuf.length, 20); // compressed size
    cdh.writeUInt32LE(dataBuf.length, 24); // uncompressed size
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([cdh, nameBuf]));

    locals.push(localRecord);
    offset += localRecord.length;
  }
  const localBlob = Buffer.concat(locals);
  const centralBlob = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); // entries this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralBlob.length, 12); // CD size
  eocd.writeUInt32LE(localBlob.length, 16); // CD offset
  return Buffer.concat([localBlob, centralBlob, eocd]);
}

test('detectDocumentFormat maps extensions and mime types', () => {
  assert.equal(detectDocumentFormat('notes.md'), 'text');
  assert.equal(detectDocumentFormat('a.html'), 'html');
  assert.equal(detectDocumentFormat('report.docx'), 'docx');
  assert.equal(detectDocumentFormat('deck.pptx'), 'pptx');
  assert.equal(detectDocumentFormat('data.xlsx'), 'xlsx');
  assert.equal(detectDocumentFormat('paper.pdf'), 'pdf');
  assert.equal(detectDocumentFormat('', 'text/plain'), 'text');
  assert.equal(detectDocumentFormat('mystery.bin'), '');
  assert.equal(isSupportedDocument('legacy.doc'), false);
});

test('zip reader round-trips stored entries', () => {
  const zip = buildStoredZip([{ name: 'hello.txt', content: 'hi there' }]);
  const dir = readZipDirectory(zip);
  assert.ok(dir.has('hello.txt'));
  assert.equal(readZipEntryText(zip, dir, 'hello.txt'), 'hi there');
});

test('extracts plain text with offset/maxChars windowing', async () => {
  const buffer = Buffer.from('line one\nline two\nline three', 'utf8');
  const res = await documentExtractor.extract({ buffer, name: 'sample.txt' });
  assert.equal(res.ok, true);
  assert.equal(res.format, 'text');
  assert.match(res.text, /line one/);

  const windowed = await documentExtractor.extract({ buffer, name: 'sample.txt', maxChars: 1000, offset: 9 });
  assert.equal(windowed.ok, true);
  assert.match(windowed.text, /^line two/);
});

test('extracts HTML to readable text', async () => {
  const html = '<html><head><title>T</title><style>x{}</style></head><body><h1>Head</h1><p>Para &amp; more</p></body></html>';
  const res = await documentExtractor.extract({ buffer: Buffer.from(html), name: 'page.html' });
  assert.equal(res.ok, true);
  assert.match(res.text, /Head/);
  assert.match(res.text, /Para & more/);
  assert.doesNotMatch(res.text, /<p>|x\{\}/);
});

test('extracts docx body text from a synthetic OOXML zip', async () => {
  const documentXml = '<?xml version="1.0"?><w:document xmlns:w="ns"><w:body>'
    + '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t xml:space="preserve">World &amp; more</w:t></w:r></w:p>'
    + '</w:body></w:document>';
  const zip = buildStoredZip([{ name: 'word/document.xml', content: documentXml }]);
  const res = await documentExtractor.extract({ buffer: zip, name: 'doc.docx' });
  assert.equal(res.ok, true);
  assert.equal(res.format, 'docx');
  assert.match(res.text, /Hello/);
  assert.match(res.text, /World & more/);
});

test('extracts xlsx cells via shared strings', async () => {
  const sharedStrings = '<sst xmlns="ns"><si><t>Name</t></si><si><t>Alice</t></si></sst>';
  const sheet = '<worksheet><sheetData>'
    + '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
    + '<row><c r="A2"><v>42</v></c></row>'
    + '</sheetData></worksheet>';
  const zip = buildStoredZip([
    { name: 'xl/sharedStrings.xml', content: sharedStrings },
    { name: 'xl/worksheets/sheet1.xml', content: sheet }
  ]);
  const res = await documentExtractor.extract({ buffer: zip, name: 'book.xlsx' });
  assert.equal(res.ok, true);
  assert.equal(res.format, 'xlsx');
  assert.match(res.text, /Name\tAlice/);
  assert.match(res.text, /42/);
});

test('unsupported and legacy formats fail gracefully', async () => {
  const res = await documentExtractor.extract({ buffer: Buffer.from('x'), name: 'mystery.bin' });
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'unsupported_format');

  const legacy = await documentExtractor.extract({ buffer: Buffer.from('x'), name: 'old.doc' });
  assert.equal(legacy.ok, false);
  assert.equal(legacy.kind, 'unsupported_format');
  assert.match(legacy.error, /\.docx/);
});

test('invalid PDF bytes fail without throwing', async () => {
  const res = await documentExtractor.extract({ buffer: Buffer.from('%PDF-1.4 not really'), name: 'broken.pdf' });
  assert.equal(res.ok, false);
  // Either the parser rejected it (extract_failed) or pdfjs is unavailable.
  assert.ok(['extract_failed', 'extractor_unavailable'].includes(res.kind), `unexpected kind: ${res.kind}`);
});
