// Frontend speech-to-text helpers for the chat composer.
//
// Layered, with automatic fallback (mirrors the server's multi-provider design):
//   1) record audio with MediaRecorder (works in browser AND Electron)
//   2) prefer the server endpoint /api/chat/transcribe (account/key pool, "B")
//   3) fall back to in-browser Whisper via transformers.js ("C") when the server
//      has no usable key / errors — so voice input ALWAYS works.
//
// Every browser API (navigator, MediaRecorder, AudioContext, dynamic CDN import)
// is referenced lazily INSIDE functions, so this module imports cleanly in Node
// (the orchestration is unit-tested there with injected implementations).

// Pin the v3 line: stable `pipeline()` API. Loaded on first fallback use only.
// Both hosts are overridable at runtime via localStorage (no rebuild needed) so
// users in regions where jsdelivr / huggingface.co are blocked can point at a
// mirror, e.g. localStorage['cligate-hf-mirror'] = 'https://hf-mirror.com'.
const DEFAULT_TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
const WHISPER_MODEL = 'Xenova/whisper-tiny';

function sttOverride(key) {
  try {
    return (typeof localStorage !== 'undefined' && localStorage.getItem(key)) || '';
  } catch {
    return '';
  }
}
const WHISPER_LANGUAGES = { zh: 'chinese', cn: 'chinese', en: 'english' };

// MediaRecorder containers, best first. OpenAI accepts webm/opus directly.
function pickRecordingMime() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return prefs.find((mime) => MediaRecorder.isTypeSupported(mime)) || '';
}

// Thin wrapper around getUserMedia + MediaRecorder. start() → stop() → Blob.
export function createAudioRecorder() {
  let mediaRecorder = null;
  let stream = null;
  let chunks = [];

  function cleanup() {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    mediaRecorder = null;
    chunks = [];
  }

  return {
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      const mime = pickRecordingMime();
      mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      mediaRecorder.start();
    },
    stop() {
      return new Promise((resolve) => {
        if (!mediaRecorder) { resolve(null); return; }
        const type = mediaRecorder.mimeType || 'audio/webm';
        mediaRecorder.onstop = () => {
          const blob = new Blob(chunks, { type });
          cleanup();
          resolve(blob);
        };
        try { mediaRecorder.stop(); } catch { cleanup(); resolve(null); }
      });
    },
    cancel() { cleanup(); },
    get recording() { return Boolean(mediaRecorder) && mediaRecorder.state === 'recording'; }
  };
}

// Does the server have a usable transcription key? Cheap GET, never throws.
export async function probeServerCapability({ fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl('/api/chat/transcribe/capabilities');
    if (!res.ok) return { available: false };
    const json = await res.json();
    return json?.server || { available: false };
  } catch {
    return { available: false };
  }
}

// POST raw audio to the server. Throws an Error carrying `.kind`/`.status` so the
// orchestrator can decide whether to fall back to local Whisper.
export async function transcribeViaServer(blob, { lang = '', fetchImpl = fetch } = {}) {
  const url = `/api/chat/transcribe${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'audio/webm' },
    body: blob
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    const error = new Error(json?.error || `server transcription failed (${res.status})`);
    error.kind = json?.kind || (res.status === 503 ? 'no_credential' : res.status === 429 ? 'rate_limited' : 'transcribe_failed');
    error.status = res.status;
    throw error;
  }
  return { text: String(json?.text || '').trim(), backend: `server:${json?.provider || ''}` };
}

// --- In-browser Whisper (transformers.js) -------------------------------
let whisperPipelinePromise = null;

async function loadWhisper(onProgress) {
  if (!whisperPipelinePromise) {
    whisperPipelinePromise = (async () => {
      const cdn = sttOverride('cligate-transformers-cdn') || DEFAULT_TRANSFORMERS_CDN;
      let lib;
      try {
        console.info('[voice] loading speech library from', cdn);
        lib = await import(cdn);
      } catch (error) {
        throw new Error(`failed to load the speech library from ${cdn} — check network/CDN access (${error?.message || error})`);
      }
      const { pipeline, env } = lib;
      // Download the model from the HF hub (cached by the browser afterwards).
      if (env) {
        env.allowLocalModels = false;
        const mirror = sttOverride('cligate-hf-mirror');
        if (mirror) {
          env.remoteHost = mirror;
          console.info('[voice] using model mirror', mirror);
        }
      }
      try {
        console.info('[voice] loading Whisper model', WHISPER_MODEL);
        return await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
          progress_callback: typeof onProgress === 'function' ? onProgress : undefined
        });
      } catch (error) {
        const host = (env && env.remoteHost) || 'huggingface.co';
        throw new Error(`failed to download the Whisper model from ${host} — check network or set a mirror (${error?.message || error})`);
      }
    })().catch((error) => { whisperPipelinePromise = null; throw error; });
  }
  return whisperPipelinePromise;
}

// Decode an arbitrary audio Blob to 16kHz mono Float32 PCM (what Whisper wants).
async function blobToPcm16k(blob) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate: 16000 });
  try {
    const audioBuffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (audioBuffer.numberOfChannels === 1) return audioBuffer.getChannelData(0);
    const length = audioBuffer.length;
    const mixed = new Float32Array(length);
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) mixed[i] += data[i] / audioBuffer.numberOfChannels;
    }
    return mixed;
  } finally {
    if (typeof ctx.close === 'function') ctx.close();
  }
}

export async function transcribeViaWhisper(blob, { lang = '', onProgress } = {}) {
  const transcriber = await loadWhisper(onProgress);
  const pcm = await blobToPcm16k(blob);
  const options = { task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 };
  const language = WHISPER_LANGUAGES[String(lang || '').toLowerCase()];
  if (language) options.language = language; // else let Whisper auto-detect
  const result = await transcriber(pcm, options);
  const text = Array.isArray(result)
    ? result.map((part) => part?.text || '').join(' ')
    : String(result?.text || '');
  return { text: text.trim(), backend: 'whisper' };
}

// Orchestrator: prefer server (when available), fall back to local Whisper.
// Implementations are injectable for testing.
export async function transcribeAudio(blob, {
  lang = '',
  serverAvailable = null,
  onWhisperProgress = null,
  serverImpl = transcribeViaServer,
  whisperImpl = transcribeViaWhisper,
  probeImpl = probeServerCapability
} = {}) {
  let canUseServer = serverAvailable;
  if (canUseServer === null || canUseServer === undefined) {
    const cap = await probeImpl();
    canUseServer = cap?.available === true;
  }
  if (canUseServer) {
    try {
      return await serverImpl(blob, { lang });
    } catch (error) {
      // any server failure → fall through to local Whisper
      console.warn('[voice] server transcription failed; falling back to in-browser Whisper:', error?.kind || '', error?.message || error);
    }
  }
  try {
    return await whisperImpl(blob, { lang, onProgress: onWhisperProgress });
  } catch (error) {
    console.error('[voice] in-browser Whisper transcription failed:', error?.message || error);
    throw error;
  }
}

export default {
  createAudioRecorder,
  probeServerCapability,
  transcribeViaServer,
  transcribeViaWhisper,
  transcribeAudio
};
