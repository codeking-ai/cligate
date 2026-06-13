// Server-side transcription orchestrator (backend "B"). Picks an available API
// key from CliGate's existing pool and tries OpenAI first, then Gemini, writing
// rate-limit/error state back so the pool stays healthy. Returns text or a
// recoverable error; the frontend falls back to in-browser Whisper ("C") when
// this reports no_credential / rate_limited / transcribe_failed.
//
// Depends only on the credential CORE (api-key-manager), not on any route.

import {
  selectKey,
  hasKeysForTypes,
  getKeyRateLimitInfo,
  recordRateLimit,
  recordError,
  recordUsage
} from '../api-key-manager.js';

import { transcribeOpenAI, DEFAULT_OPENAI_BASE_URL } from './providers/openai.js';
import { transcribeGemini, DEFAULT_GEMINI_BASE_URL } from './providers/gemini.js';

const STT_KEY_TYPES = ['openai', 'gemini'];

function envModels(name) {
  const raw = String(process.env[name] || '').trim();
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : null;
}

export class TranscriptionService {
  constructor({
    selectKeyImpl = selectKey,
    hasKeys = hasKeysForTypes,
    rateLimitInfo = getKeyRateLimitInfo,
    openaiImpl = transcribeOpenAI,
    geminiImpl = transcribeGemini
  } = {}) {
    this.selectKey = selectKeyImpl;
    this.hasKeys = hasKeys;
    this.rateLimitInfo = rateLimitInfo;
    this.openai = openaiImpl;
    this.gemini = geminiImpl;
  }

  // Capability snapshot for GET /api/chat/transcribe/capabilities.
  capabilities() {
    const providers = STT_KEY_TYPES.filter((type) => this.hasKeys([type]));
    const info = this.rateLimitInfo(STT_KEY_TYPES);
    return {
      available: providers.length > 0,
      providers,
      rateLimitedMs: providers.length > 0 && info.allRateLimited ? info.minWaitMs : 0
    };
  }

  async transcribe({ audio, mimeType = 'audio/webm', language = '' } = {}) {
    if (!audio || !audio.length) return { ok: false, kind: 'transcribe_failed', error: 'empty audio' };
    if (!this.hasKeys(STT_KEY_TYPES)) {
      return { ok: false, kind: 'no_credential', error: 'no OpenAI/Gemini API key configured for transcription' };
    }
    const info = this.rateLimitInfo(STT_KEY_TYPES);
    if (info.allRateLimited) {
      return { ok: false, kind: 'rate_limited', error: 'all transcription keys are rate limited', retryMs: info.minWaitMs };
    }

    const attempts = [
      {
        type: 'openai',
        run: (provider) => this.openai({
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl || DEFAULT_OPENAI_BASE_URL,
          audio,
          mimeType,
          language,
          models: envModels('CLIGATE_STT_OPENAI_MODELS') || undefined
        })
      },
      {
        type: 'gemini',
        run: (provider) => this.gemini({
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl || DEFAULT_GEMINI_BASE_URL,
          audio,
          mimeType,
          language,
          model: String(process.env.CLIGATE_STT_GEMINI_MODEL || '').trim() || undefined
        })
      }
    ];

    let lastError = 'transcription failed';
    for (const attempt of attempts) {
      const provider = this.selectKey(attempt.type);
      if (!provider || provider.isAvailable === false) continue;

      let result;
      try {
        result = await attempt.run(provider);
      } catch (error) {
        result = { ok: false, kind: 'transcribe_failed', error: String(error?.message || error) };
      }

      if (result.ok) {
        try { recordUsage(provider.id, { model: result.model || attempt.type }); } catch { /* non-fatal */ }
        return { ok: true, text: String(result.text || '').trim(), provider: attempt.type, model: result.model || '' };
      }
      if (result.kind === 'rate_limited') {
        try { recordRateLimit(provider.id, 60000); } catch { /* non-fatal */ }
      } else {
        try { recordError(provider.id); } catch { /* non-fatal */ }
      }
      lastError = result.error || lastError;
    }

    return { ok: false, kind: 'transcribe_failed', error: lastError };
  }
}

export const transcriptionService = new TranscriptionService();

export default transcriptionService;
