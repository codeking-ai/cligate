import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile } from 'node:fs/promises';

import { handleChatUpload, resolveUploadsRoot } from '../../src/routes/chat-uploads-route.js';

async function withServer(run) {
  const app = express();
  // Registered with no body parser, exactly like server.js places it before
  // express.json() — the handler must consume the raw request stream itself.
  app.post('/api/chat/uploads', handleChatUpload);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/chat/uploads`;
  try {
    return await run(base);
  } finally {
    server.close();
  }
}

test('upload stores a supported document and reports a bucketed path under the uploads root', async () => {
  await withServer(async (base) => {
    const body = '# Quarterly\n\nNumbers attached.';
    const res = await fetch(`${base}?sessionId=chat_abc&name=${encodeURIComponent('notes.md')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/markdown' },
      body
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.file.name, 'notes.md');
    assert.ok(json.file.path.startsWith(resolveUploadsRoot()));
    assert.ok(json.file.path.includes('chat_abc'));
    assert.equal(await readFile(json.file.path, 'utf8'), body);
  });
});

test('upload preserves digits and the extension in the filename (regression: char-class range ate them)', async () => {
  await withServer(async (base) => {
    // Content-Type is deliberately non-descriptive so format detection depends
    // ENTIRELY on the preserved ".pdf" extension. If sanitizeFileName mangled
    // "report2024.pdf" → "report_____pdf", detection would fail with 415.
    const res = await fetch(`${base}?sessionId=chat_x&name=${encodeURIComponent('report2024.pdf')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: '%PDF-1.4 stub'
    });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.file.name, 'report2024.pdf');
  });
});

test('upload sanitizes a traversal-laden filename to a safe basename', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}?sessionId=chat_x&name=${encodeURIComponent('..\\..\\secret report.docx')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      body: 'PK stub'
    });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    // basename only, separators gone, spaces + extension preserved.
    assert.equal(json.file.name, 'secret report.docx');
    assert.ok(!json.file.name.includes('..'));
  });
});

test('upload rejects unsupported types, oversize sessions, and missing params', async () => {
  await withServer(async (base) => {
    const unsupported = await fetch(`${base}?sessionId=chat_x&name=evil.exe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: 'x'
    });
    assert.equal(unsupported.status, 415);

    const noSession = await fetch(`${base}?name=a.txt`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'x'
    });
    assert.equal(noSession.status, 400);

    const noName = await fetch(`${base}?sessionId=chat_x`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'x'
    });
    assert.equal(noName.status, 400);
  });
});
