// Speech-to-text endpoints for the chat composer (backend "B").
//
//   GET  /api/chat/transcribe/capabilities  → which server backends are usable
//   POST /api/chat/transcribe               → raw audio bytes in, transcript out
//
// The POST body is raw audio (no JSON), so both are registered in server.js
// BEFORE express.json() — same precedent as /responses and /api/chat/uploads.
// When the server has no usable key (503) or is rate limited (429), the frontend
// falls back to in-browser Whisper. See docs/voice-recognition-design.zh-CN.md.

import { transcriptionService, MAX_AUDIO_BYTES, isSupportedAudioMime, normalizeAudioMime } from '../speech-to-text/index.js';

export function handleTranscribeCapabilities(_req, res) {
  try {
    return res.json({ success: true, server: transcriptionService.capabilities() });
  } catch (error) {
    return res.status(500).json({ success: false, error: String(error?.message || error) });
  }
}

function readAudioBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('audio too large'), { code: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function handleTranscribe(req, res) {
  const mimeType = normalizeAudioMime(req.headers['content-type'] || 'audio/webm');
  const language = String(req.query?.lang || '').trim();
  if (!isSupportedAudioMime(mimeType)) {
    return res.status(415).json({ success: false, error: `unsupported audio type: ${mimeType || 'unknown'}` });
  }

  let audio;
  try {
    audio = await readAudioBody(req, MAX_AUDIO_BYTES);
  } catch (error) {
    if (error?.code === 'too_large') {
      return res.status(413).json({ success: false, error: `audio exceeds the ${MAX_AUDIO_BYTES}-byte limit` });
    }
    return res.status(400).json({ success: false, error: `failed to read audio: ${String(error?.message || error)}` });
  }
  if (!audio.length) {
    return res.status(400).json({ success: false, error: 'empty audio' });
  }

  const result = await transcriptionService.transcribe({ audio, mimeType, language });
  if (!result.ok) {
    // Map to status codes the frontend uses to decide whether to fall back to
    // in-browser Whisper: 503 (no key) and 429 (rate limited) both trigger
    // fallback; 502 is an upstream transcription failure.
    const status = result.kind === 'no_credential' ? 503 : result.kind === 'rate_limited' ? 429 : 502;
    return res.status(status).json({
      success: false,
      kind: result.kind,
      error: result.error,
      ...(result.retryMs ? { retryMs: result.retryMs } : {})
    });
  }
  return res.json({ success: true, text: result.text, provider: result.provider, model: result.model });
}

export default handleTranscribe;
