// OpenAI transcription provider — pure function: given a key + audio bytes,
// returns transcript text. No credential selection here (the service does that),
// so it is trivially unit-testable with a mock fetch.
//
// Endpoint: POST {baseUrl}/audio/transcriptions  (multipart/form-data)
// Auth: Authorization: Bearer <key>. Accepts webm/opus directly, so the audio
// recorded by the browser's MediaRecorder needs no transcoding.

import { audioFilenameForMime } from '../safety.js';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
// gpt-4o-mini-transcribe is more accurate than whisper-1; fall back to whisper-1
// for endpoints/proxies that only expose the classic model.
export const DEFAULT_OPENAI_MODELS = ['gpt-4o-mini-transcribe', 'whisper-1'];

function readTranscriptText(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  // response_format=text returns the transcript verbatim, but some compatible
  // endpoints answer with JSON regardless — handle both.
  if (text.startsWith('{')) {
    try {
      return String(JSON.parse(text)?.text || '').trim();
    } catch {
      return text;
    }
  }
  return text;
}

export async function transcribeOpenAI({
  apiKey,
  baseUrl = DEFAULT_OPENAI_BASE_URL,
  audio,
  mimeType = 'audio/webm',
  language = '',
  models = DEFAULT_OPENAI_MODELS,
  fetchImpl = globalThis.fetch.bind(globalThis),
  timeoutMs = 60000
} = {}) {
  if (!apiKey) return { ok: false, kind: 'no_credential', error: 'missing OpenAI api key' };
  if (!audio || !audio.length) return { ok: false, kind: 'transcribe_failed', error: 'empty audio' };

  const url = `${String(baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/$/, '')}/audio/transcriptions`;
  const filename = audioFilenameForMime(mimeType);
  const modelList = Array.isArray(models) && models.length ? models : DEFAULT_OPENAI_MODELS;

  let lastError = 'transcription failed';
  for (const model of modelList) {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mimeType || 'audio/webm' }), filename);
    form.append('model', model);
    form.append('response_format', 'text');
    if (language) form.append('language', language);

    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      lastError = String(error?.message || error);
      continue;
    }

    if (response.status === 429) {
      return { ok: false, kind: 'rate_limited', status: 429, error: 'openai rate limited' };
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      lastError = `HTTP ${response.status} ${detail.slice(0, 300)}`;
      // Model not available on this endpoint → try the next model; other errors
      // are unlikely to be fixed by a different model, but retrying is cheap.
      if (response.status === 400 || response.status === 404) continue;
      return { ok: false, kind: 'transcribe_failed', error: lastError };
    }

    const text = readTranscriptText(await response.text());
    return { ok: true, text, model };
  }
  return { ok: false, kind: 'transcribe_failed', error: lastError };
}

export default transcribeOpenAI;
