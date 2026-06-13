// Public surface of the speech-to-text module (backend "B"). Internals
// (providers, safety) stay private. See docs/voice-recognition-design.zh-CN.md.
// Mirrors src/web-search/index.js.
export { TranscriptionService, transcriptionService } from './transcription-service.js';
export { MAX_AUDIO_BYTES, isSupportedAudioMime, normalizeAudioMime } from './safety.js';
export { transcribeOpenAI } from './providers/openai.js';
export { transcribeGemini } from './providers/gemini.js';
