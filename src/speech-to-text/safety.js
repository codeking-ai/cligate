// Guards for the speech-to-text module: cap audio size and recognize the audio
// container types our browsers (MediaRecorder) and upstream providers accept.
// Mirrors the role of src/web-search/safety.js / document-extraction/safety.js.

// OpenAI's transcription endpoint caps uploads at 25MB; we use the same ceiling
// to bound the Node process memory (transcription needs the whole clip at once,
// unlike file uploads which stream to disk).
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// Container/mime → file extension used when posting multipart to OpenAI.
const AUDIO_MIME_EXTENSIONS = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/oga': 'oga',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
  'audio/mpga': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac'
};

export function normalizeAudioMime(mimeType = '') {
  return String(mimeType || '').split(';')[0].trim().toLowerCase();
}

export function isSupportedAudioMime(mimeType = '') {
  const mime = normalizeAudioMime(mimeType);
  return mime.startsWith('audio/') || Object.prototype.hasOwnProperty.call(AUDIO_MIME_EXTENSIONS, mime);
}

// Best-effort filename for the multipart upload (OpenAI infers format from it).
export function audioFilenameForMime(mimeType = '') {
  const ext = AUDIO_MIME_EXTENSIONS[normalizeAudioMime(mimeType)] || 'webm';
  return `audio.${ext}`;
}

export default { MAX_AUDIO_BYTES, normalizeAudioMime, isSupportedAudioMime, audioFilenameForMime };
