// Local file-upload endpoint for the dashboard chat composer.
//
// "Upload" here is purely an intra-machine transfer: the browser/Electron
// renderer cannot read a picked file's absolute path (sandbox), so it streams
// the raw bytes over localhost to this Node process, which writes them under
// ~/.cligate/uploads/<sessionId>/. Nothing leaves the box. Because ~/.cligate
// is an always-readable workspace-guard root, the assistant's read_document
// tool can then read the file with no extra path grants.
//
// Registered in server.js BEFORE express.json() (like /responses): the body is
// raw bytes streamed straight to disk, so it must not pass through the JSON
// body parser or be buffered into memory. See docs/file-attachment-design.zh-CN.md.

import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { resolveCligateConfigDir } from '../assistant-tools/index.js';
import { isSupportedDocument, MAX_DOCUMENT_BYTES } from '../document-extraction/index.js';

class ByteCapExceededError extends Error {}

export function resolveUploadsRoot() {
  return path.join(resolveCligateConfigDir(), 'uploads');
}

// Session ids are client-generated (`chat_xxx`); confine them to a safe slug so
// they can never escape the uploads root via traversal.
function sanitizeSessionId(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
}

// Keep the basename and a recognizable (possibly non-ASCII) name, but strip
// path separators, Windows-reserved characters, and control chars. dots/digits
// MUST survive: read_document detects the format from the saved file's
// extension, so losing ".pdf" would make the upload unreadable. (Note: the
// class below is an explicit list, NOT a range — `[ -<...]` would be a
// space-to-'<' range that silently eats digits and dots.)
function sanitizeFileName(value) {
  const base = path.basename(String(value || '').trim());
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 120) || 'file';
}

// Transform that aborts the pipeline once the byte cap is crossed, with proper
// backpressure (no manual 'data' listeners racing express.json's stream).
function byteCapTransform(maxBytes) {
  let total = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) {
        cb(new ByteCapExceededError());
        return;
      }
      cb(null, chunk);
    }
  });
}

export async function handleChatUpload(req, res) {
  const sessionId = sanitizeSessionId(req.query?.sessionId);
  const rawName = String(req.query?.name || '').trim();
  if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId is required' });
  if (!rawName) return res.status(400).json({ success: false, error: 'name is required' });

  const safeName = sanitizeFileName(rawName);
  const mediaType = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!isSupportedDocument(safeName, mediaType)) {
    return res.status(415).json({
      success: false,
      error: `unsupported document type: ${safeName}. Supported: pdf, docx, pptx, xlsx, and text/markdown/csv/json/html.`
    });
  }

  // Reject early when the client declares an over-size body.
  const declared = Number.parseInt(String(req.headers['content-length'] || ''), 10);
  if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) {
    return res.status(413).json({ success: false, error: `file exceeds the ${MAX_DOCUMENT_BYTES}-byte limit` });
  }

  const dir = path.join(resolveUploadsRoot(), sessionId);
  const fileId = randomUUID();
  const destPath = path.join(dir, `${fileId}-${safeName}`);

  try {
    await mkdir(dir, { recursive: true });
    await pipeline(req, byteCapTransform(MAX_DOCUMENT_BYTES), createWriteStream(destPath));
  } catch (error) {
    await unlink(destPath).catch(() => {});
    if (error instanceof ByteCapExceededError) {
      return res.status(413).json({ success: false, error: `file exceeds the ${MAX_DOCUMENT_BYTES}-byte limit` });
    }
    return res.status(400).json({ success: false, error: `upload failed: ${String(error?.message || error)}` });
  }

  let info;
  try {
    info = await stat(destPath);
  } catch (error) {
    return res.status(500).json({ success: false, error: String(error?.message || error) });
  }
  if (info.size === 0) {
    await unlink(destPath).catch(() => {});
    return res.status(400).json({ success: false, error: 'uploaded file is empty' });
  }

  return res.json({
    success: true,
    file: {
      fileId,
      name: safeName,
      mediaType,
      size: info.size,
      path: destPath
    }
  });
}

export default handleChatUpload;
