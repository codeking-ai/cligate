// Gemini transcription provider — pure function. Gemini has no dedicated audio
// endpoint; it transcribes via generateContent with the audio passed as inline
// base64 data plus a text instruction. API key goes in the `?key=` query param.
//
// Note: Gemini's accepted audio containers are narrower than OpenAI's (webm/opus
// support is not guaranteed). When it rejects the clip we return a recoverable
// error and the caller falls through to the in-browser Whisper fallback.

export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => String(part?.text || '')).join('').trim();
}

export async function transcribeGemini({
  apiKey,
  baseUrl = DEFAULT_GEMINI_BASE_URL,
  audio,
  mimeType = 'audio/webm',
  language = '',
  model = DEFAULT_GEMINI_MODEL,
  fetchImpl = globalThis.fetch.bind(globalThis),
  timeoutMs = 60000
} = {}) {
  if (!apiKey) return { ok: false, kind: 'no_credential', error: 'missing Gemini api key' };
  if (!audio || !audio.length) return { ok: false, kind: 'transcribe_failed', error: 'empty audio' };

  const url = `${String(baseUrl || DEFAULT_GEMINI_BASE_URL).replace(/\/$/, '')}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const instruction = language
    ? `Transcribe this audio (language: ${language}) verbatim. Return ONLY the transcript text, with no commentary.`
    : 'Transcribe this audio verbatim. Return ONLY the transcript text, with no commentary.';
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: String(mimeType || 'audio/webm').split(';')[0], data: Buffer.from(audio).toString('base64') } },
        { text: instruction }
      ]
    }],
    generationConfig: { temperature: 0 }
  };

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return { ok: false, kind: 'transcribe_failed', error: String(error?.message || error) };
  }

  if (response.status === 429) {
    return { ok: false, kind: 'rate_limited', status: 429, error: 'gemini rate limited' };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return { ok: false, kind: 'transcribe_failed', error: `HTTP ${response.status} ${detail.slice(0, 300)}` };
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    return { ok: false, kind: 'transcribe_failed', error: `bad gemini response: ${String(error?.message || error)}` };
  }
  return { ok: true, text: extractText(data), model };
}

export default transcribeGemini;
