// Minimal, dependency-free ZIP reader for OOXML documents (docx/pptx/xlsx are
// just ZIP archives of XML). We deliberately parse via the CENTRAL DIRECTORY
// (not local-header streaming): the central directory carries authoritative
// compressed/uncompressed sizes and offsets, sidestepping the data-descriptor
// ambiguity that streaming parsers hit. Only the two compression methods Office
// emits are supported (0 = stored, 8 = deflate, via Node's built-in zlib).
//
// Scope note: zip64 and encrypted entries are not handled — real Office files
// under 4GB never need them. Anything unparseable throws, and the extractor
// turns that into a recoverable error rather than crashing.

import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CDH_SIG = 0x02014b50; // Central Directory Header
const LFH_SIG = 0x04034b50; // Local File Header
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 0xffff;

function findEndOfCentralDirectory(buf) {
  // EOCD lives at the very end, optionally followed by a <=64KB comment. Scan
  // backwards from the latest position it could start at.
  const minPos = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

// Returns Map<entryName, { method, compressedSize, uncompressedSize, localOffset }>.
export function readZipDirectory(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < EOCD_MIN_SIZE) throw new Error('not a zip archive (too small)');
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');

  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Decompress a single central-directory entry to a Buffer.
export function readZipEntryBuffer(buffer, entry) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!entry) throw new Error('zip entry is required');
  if (buf.readUInt32LE(entry.localOffset) !== LFH_SIG) throw new Error('bad local file header');
  const nameLen = buf.readUInt16LE(entry.localOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data); // stored
  if (entry.method === 8) return zlib.inflateRawSync(data); // deflate
  throw new Error(`unsupported zip compression method ${entry.method}`);
}

// Convenience: read a named entry as a UTF-8 string, or '' if absent.
export function readZipEntryText(buffer, entries, name) {
  const entry = entries.get(name);
  if (!entry) return '';
  return readZipEntryBuffer(buffer, entry).toString('utf8');
}

export default { readZipDirectory, readZipEntryBuffer, readZipEntryText };
