import { listAccounts as listChatGptAccounts } from '../account-manager.js';
import {
  getUsableAccounts,
  listAccounts as listClaudeAccounts
} from '../claude-account-manager.js';
import { selectKey } from '../api-key-manager.js';
import { getServerSettings, setServerSettings } from '../server-settings.js';
import { logger } from '../utils/logger.js';
import { isTransientUpstreamError, backoffDelayMs, sleep } from '../utils/transient-error.js';

import { CircuitBreaker, tierKeyFor } from './circuit-breaker.js';
import {
  resolveCredential,
  describeBinding,
  listAvailableCredentials,
  DEFAULT_CHATGPT_MODEL,
  DEFAULT_CLAUDE_MODEL
} from './credential-resolver.js';

let _migrationDone = false;

/**
 * One-shot migration from legacy `assistantAgent.sources` toggles to
 * `assistantAgent.boundModelSource`. Runs at most once per process — picks the
 * first resolvable concrete credential per the historical priority order
 * (anthropic key → openai bridge → azure bridge → claude account → chatgpt
 * account) and writes it back to settings.json. Subsequent runtime config
 * reads see the new shape and skip this entirely.
 */
function migrateLegacySourcesIfNeeded(config) {
  if (_migrationDone) return config;
  if (config.boundModelSource || config.boundCredential || config.bindingConfigured === true) {
    _migrationDone = true;
    return config;
  }

  const legacy = config.sources || {};
  const tries = [];

  if (legacy.anthropicApiKey) {
    tries.push(() => {
      const provider = selectKey('anthropic');
      return provider ? { type: 'api-key', id: provider.id } : null;
    });
  }
  if (legacy.openaiApiKeyBridge) {
    tries.push(() => {
      const provider = selectKey('openai');
      return provider?.sendAnthropicRequest ? { type: 'api-key', id: provider.id } : null;
    });
  }
  if (legacy.azureOpenaiApiKeyBridge) {
    tries.push(() => {
      const provider = selectKey('azure-openai');
      return provider?.sendAnthropicRequest ? { type: 'api-key', id: provider.id } : null;
    });
  }
  if (legacy.claudeAccount) {
    tries.push(() => {
      const usable = typeof getUsableAccounts === 'function' ? getUsableAccounts() : [];
      if (Array.isArray(usable) && usable.length > 0) {
        return { type: 'claude-account', id: usable[0].email };
      }
      const snapshot = listClaudeAccounts();
      const accounts = Array.isArray(snapshot?.accounts)
        ? snapshot.accounts.filter((entry) => entry.enabled !== false)
        : [];
      if (accounts.length === 0) return null;
      return { type: 'claude-account', id: accounts[0].email };
    });
  }
  if (legacy.chatgptAccount) {
    tries.push(() => {
      const snapshot = listChatGptAccounts();
      const accounts = Array.isArray(snapshot?.accounts)
        ? snapshot.accounts.filter((entry) => entry.enabled !== false)
        : [];
      if (accounts.length === 0) return null;
      const active = accounts.find((entry) => entry.email === snapshot.activeAccount) || accounts[0];
      return { type: 'chatgpt-account', id: active.email };
    });
  }

  let resolved = null;
  for (const tryFn of tries) {
    try {
      resolved = tryFn();
      if (resolved) break;
    } catch {
      // ignore and try next
    }
  }
  _migrationDone = true;

  if (!resolved) {
    logger.info('[Supervisor] legacy supervisor config present but no concrete credential resolved; supervisor will run in fallback mode until the user binds one explicitly');
    return config;
  }

  try {
    const persisted = setServerSettings({
      assistantAgent: { ...config, boundModelSource: resolved, boundCredential: resolved }
    });
    logger.info(`[Supervisor] migrated legacy supervisor config → ${resolved.type}::${resolved.id}`);
    return persisted.assistantAgent;
  } catch (error) {
    logger.warn(`[Supervisor] legacy migration failed to persist: ${error?.message || error}`);
    return { ...config, boundModelSource: resolved, boundCredential: resolved };
  }
}

// Per-model max_tokens ceiling for supervisor turns. Picked to match each
// model's published output cap; keeping these in sync with openclaw-config's
// MODEL_METADATA is enough — supervisor only needs a sane upper bound so
// long tool_use arguments (e.g. write_file with multi-KB script bodies)
// don't get truncated mid-JSON. Anything not listed falls back to MAX_TOKENS_DEFAULT.
const MAX_TOKENS_BY_MODEL = {
  // Anthropic
  'claude-opus-4-7': 32768,
  'claude-opus-4-6': 32768,
  'claude-opus-4-6-1m': 32768,
  'claude-opus-4-5': 32768,
  'claude-sonnet-4-6': 16384,
  'claude-sonnet-4-6-1m': 16384,
  'claude-sonnet-4-5': 16384,
  'claude-haiku-4-5': 8192,
  // OpenAI / Azure
  'gpt-5.4': 16384,
  'gpt-5.3-codex': 32768,
  'gpt-5.2': 16384,
  'gpt-5.2-codex': 32768,
  'gpt-5.1-codex': 32768,
  // Google
  'gemini-2.5-pro': 8192,
  'gemini-2.5-flash': 8192
};
const MAX_TOKENS_DEFAULT = 8192;
const MAX_TOKENS_FLOOR = 4096;
const MAX_TOKENS_HARD_CEIL = 65536;
const LLM_TURN_TIMEOUT_MS = Number.parseInt(process.env.CLIGATE_ASSISTANT_TURN_TIMEOUT_MS, 10) || 180_000;

export function resolveMaxTokensForModel(model = '', { override = null } = {}) {
  // Caller-supplied override wins, then env, then per-model table, then default.
  // All values are clamped into [MAX_TOKENS_FLOOR, MAX_TOKENS_HARD_CEIL].
  const candidates = [];
  if (Number.isFinite(override) && override > 0) {
    candidates.push(override);
  }
  const envRaw = Number.parseInt(process.env.CLIGATE_ASSISTANT_MAX_TOKENS, 10);
  if (Number.isFinite(envRaw) && envRaw > 0) {
    candidates.push(envRaw);
  }
  const tableValue = MAX_TOKENS_BY_MODEL[String(model || '').trim()];
  if (Number.isFinite(tableValue) && tableValue > 0) {
    candidates.push(tableValue);
  }
  candidates.push(MAX_TOKENS_DEFAULT);
  const picked = candidates.find((value) => Number.isFinite(value) && value > 0) || MAX_TOKENS_DEFAULT;
  return Math.min(MAX_TOKENS_HARD_CEIL, Math.max(MAX_TOKENS_FLOOR, picked));
}

/**
 * Bucket a tier failure into one of three classes so the supervisor knows
 * what to do with it:
 *
 *   - transient: ECONNRESET, fetch failed, timeout — same tier might work on
 *     the next attempt. Worth one same-tier retry before moving on.
 *   - permanent: 400 INVALID_REQUEST (e.g. "gpt-5.4 not supported when using
 *     Codex with a ChatGPT account"), AUTH_EXPIRED (revoked token),
 *     CLOUDFLARE_BLOCKED, MODEL_QUOTA_EXHAUSTED. Won't resolve by waiting;
 *     mark the tier disabled so the next caller doesn't waste a slot on it.
 *   - rateLimited: 429. Tier *will* work later but not now; let the breaker
 *     park it via its normal tripped state for the cooldown window.
 *   - other: anything else (most 5xx). Counts toward the regular breaker
 *     budget; recoverable but not immediately retryable.
 */
function classifyTierError(error) {
  if (isTransientUpstreamError(error)) return 'transient';
  const message = String(error?.message || error || '');
  if (/^RATE_LIMITED/i.test(message)) return 'rateLimited';
  if (/^(INVALID_REQUEST|AUTH_EXPIRED|CLOUDFLARE_BLOCKED|MODEL_QUOTA_EXHAUSTED|FORBIDDEN)/i.test(message)) {
    return 'permanent';
  }
  // Anthropic 4xx surfaces as "CLAUDE_API_ERROR: 400 - ..." — treat 4xx (but
  // not 5xx) as permanent so the breaker doesn't burn through fallback tiers
  // for the same client-side problem.
  const claudeMatch = message.match(/^CLAUDE_API_ERROR:\s*(\d{3})/i);
  if (claudeMatch) {
    const status = Number(claudeMatch[1]);
    if (Number.isFinite(status) && status >= 400 && status < 500) return 'permanent';
  }
  return 'other';
}

async function withTurnTimeout(promise, timeoutMs, label = 'assistant_llm_turn') {
  // Wrap upstream provider call so a hung connection (e.g. Azure stalled mid-stream)
  // can't freeze the whole ReAct loop. Throws a labeled error the caller can match
  // on to emit a structured trace.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label}_timeout_after_${timeoutMs}ms`);
      err.code = 'ASSISTANT_LLM_TURN_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class AssistantLlmClient {
  constructor({
    defaultChatGptModel = DEFAULT_CHATGPT_MODEL,
    defaultClaudeModel = DEFAULT_CLAUDE_MODEL,
    enabled = process.env.CLIGATE_ENABLE_ASSISTANT_AGENT !== '0'
  } = {}) {
    this.defaultChatGptModel = defaultChatGptModel;
    this.defaultClaudeModel = defaultClaudeModel;
    this.enabled = enabled === true;
    this._breaker = new CircuitBreaker();
    this._lastUsed = null; // { descriptor, kind, label, model, at }
    this._lastFallbackReason = '';
  }

  // ─── Config + migration ──────────────────────────────────────────────────

  getRuntimeConfig() {
    const settings = getServerSettings();
    const stored = settings?.assistantAgent && typeof settings.assistantAgent === 'object'
      ? settings.assistantAgent
      : null;

    let config = stored
      ? {
          enabled: stored.enabled === true,
          bindingConfigured: stored.bindingConfigured === true,
          boundModelSource: stored.boundModelSource || stored.boundCredential || null,
          boundCredential: stored.boundModelSource || stored.boundCredential || null,
          fallbacks: Array.isArray(stored.fallbacks) ? stored.fallbacks : [],
          circuitBreaker: stored.circuitBreaker || { failureThreshold: 3, probeIntervalMs: 300_000 },
          sources: stored.sources || {}
        }
      : {
          enabled: this.enabled,
          bindingConfigured: false,
          boundModelSource: null,
          boundCredential: null,
          fallbacks: [],
          circuitBreaker: { failureThreshold: 3, probeIntervalMs: 300_000 },
          sources: {}
        };

    config = migrateLegacySourcesIfNeeded(config);
    this._breaker.updateThresholds(config.circuitBreaker);
    return config;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _chainDescriptors(config) {
    const chain = [];
    if (config.boundModelSource || config.boundCredential) {
      chain.push(config.boundModelSource || config.boundCredential);
    }
    if (Array.isArray(config.fallbacks)) {
      for (const entry of config.fallbacks) {
        if (entry && typeof entry === 'object' && entry.type && entry.id) {
          chain.push(entry);
        }
      }
    }
    return chain;
  }

  _pruneBreaker(chain) {
    this._breaker.pruneTo(chain.map((descriptor) => tierKeyFor(descriptor)));
  }

  // ─── Source resolution ───────────────────────────────────────────────────

  async hasAvailableSource() {
    if (!this.getRuntimeConfig().enabled) return false;
    const candidates = await this.listCandidateSources();
    return candidates.length > 0;
  }

  getFallbackReason() {
    const config = this.getRuntimeConfig();
    if (!config.enabled) return 'assistant_agent_disabled';
    if (this._lastFallbackReason) return this._lastFallbackReason;
    if (!(config.boundModelSource || config.boundCredential)) return 'no_supervisor_binding';
    return 'no_available_llm_source';
  }

  /**
   * Walk the binding chain (primary then ordered fallbacks). For each tier:
   *   - skip if circuit breaker says the tier is in cooldown
   *   - resolve the credential into a working candidate
   *   - skip if the credential has been deleted or disabled
   *
   * The returned list is in the order requests should try them. complete()
   * iterates this list and records success/failure on the breaker.
   */
  async listCandidateSources() {
    const config = this.getRuntimeConfig();
    if (!config.enabled) {
      throw new Error('Assistant LLM agent is disabled');
    }

    const chain = this._chainDescriptors(config);
    this._pruneBreaker(chain);

    const candidates = [];
    for (const descriptor of chain) {
      const tierKey = tierKeyFor(descriptor);
      if (this._breaker.shouldSkip(tierKey)) continue;
      const candidate = await resolveCredential(descriptor, {
        defaultChatGptModel: this.defaultChatGptModel,
        defaultClaudeModel: this.defaultClaudeModel
      });
      if (!candidate) continue;
      candidates.push({ ...candidate, tierKey });
    }
    return candidates;
  }

  async resolveSource() {
    const candidates = await this.listCandidateSources();
    if (candidates.length === 0) {
      throw new Error('No assistant model source available');
    }
    return candidates[0];
  }

  // ─── Status snapshot ─────────────────────────────────────────────────────

  /**
   * Snapshot of the current binding chain + breaker state for the UI.
   * Does NOT make any LLM calls; purely reads in-memory state and the
   * configured credential records.
   */
  async inspectStatus() {
    const config = this.getRuntimeConfig();
    const chain = this._chainDescriptors(config);
    this._pruneBreaker(chain);

    const tiers = await Promise.all(chain.map(async (descriptor, index) => {
      const tierKey = tierKeyFor(descriptor);
      const breakerState = this._breaker.getState(tierKey);
      const description = await describeBinding(descriptor);
      return {
        tier: index === 0 ? 'primary' : `fallback-${index}`,
        descriptor,
        resolved: description.ok,
        kind: description.kind || null,
        providerType: description.providerType || null,
        label: description.label || null,
        model: description.model || null,
        reason: description.ok ? '' : (description.reason || ''),
        breaker: breakerState
      };
    }));

    let resolvedSource = null;
    let fallbackReason = '';
    if (!config.enabled) {
      fallbackReason = 'Assistant LLM agent is disabled';
    } else if (chain.length === 0) {
      fallbackReason = 'No supervisor binding configured';
    } else {
      const usable = tiers.find((tier) => tier.resolved && tier.breaker.state !== 'tripped');
      if (usable) {
        resolvedSource = {
          tier: usable.tier,
          descriptor: usable.descriptor,
          kind: usable.kind,
          label: usable.label,
          model: usable.model
        };
      } else {
        fallbackReason = 'All supervisor tiers are unavailable';
      }
    }

    return {
      enabled: config.enabled,
      bindingConfigured: config.bindingConfigured === true,
      boundModelSource: config.boundModelSource || config.boundCredential,
      boundCredential: config.boundModelSource || config.boundCredential,
      fallbacks: config.fallbacks,
      circuitBreaker: config.circuitBreaker,
      tiers,
      // Backwards-compat alias for callers (older UI, route-handlers test) that
      // expect `statuses` to be an array. The shape is the same as `tiers`;
      // remove once the UI moves to the `tiers` key.
      statuses: tiers,
      resolvedSource,
      fallbackReason,
      lastUsed: this._lastUsed,
      // Catalog of all bindable credentials for the UI dropdown.
      catalog: listAvailableCredentials()
    };
  }

  // ─── Breaker controls (used by routes) ───────────────────────────────────

  resetBreaker(descriptor) {
    if (!descriptor) {
      this._breaker.resetAll();
      return;
    }
    this._breaker.reset(tierKeyFor(descriptor));
  }

  getBreakerSnapshot() {
    return this._breaker.snapshot();
  }

  // ─── Send ────────────────────────────────────────────────────────────────

  async complete({
    system,
    messages,
    tools = [],
    model = '',
    // Pre-fix this was hard-coded to 1200, which silently truncated any
    // tool_use whose arguments JSON was longer than ~1200 tokens (most write_file
    // calls during a real skill workflow). Default is now undefined: resolve via
    // resolveMaxTokensForModel(source.model) so the limit matches the model's
    // own published cap. Callers can still pass an explicit number.
    maxTokens = null,
    turnTimeoutMs = LLM_TURN_TIMEOUT_MS
  } = {}) {
    const candidates = await this.listCandidateSources();
    if (candidates.length === 0) {
      this._lastFallbackReason = 'no_available_supervisor_tier';
      throw new Error('No assistant model source available');
    }

    const failures = [];
    for (const source of candidates) {
      const effectiveModel = source.model || model;
      const effectiveMaxTokens = resolveMaxTokensForModel(effectiveModel, {
        override: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : null
      });

      // Inner attempt loop: a single same-tier retry on transient errors
      // (TCP reset, fetch failed, timeout) before moving to the next tier.
      // Bigger 4xx/quota errors break out immediately and tag the tier as
      // disabled so we don't keep paying their cost on subsequent turns.
      const MAX_TIER_ATTEMPTS = 2;
      let succeeded = false;
      let lastTierError = null;
      let lastTierClass = 'other';
      for (let attempt = 1; attempt <= MAX_TIER_ATTEMPTS; attempt += 1) {
        try {
          const response = await withTurnTimeout(
            source.send({
              system,
              messages,
              tools,
              max_tokens: effectiveMaxTokens,
              model: effectiveModel
            }),
            turnTimeoutMs,
            `assistant_llm_turn[${source.label || source.kind || 'unknown'}]`
          );
          this._breaker.recordSuccess(source.tierKey);
          this._lastUsed = {
            descriptor: source.descriptor,
            kind: source.kind,
            label: source.label,
            model: effectiveModel,
            at: Date.now()
          };
          this._lastFallbackReason = '';
          succeeded = true;
          return {
            ...response,
            source: {
              kind: source.kind,
              label: source.label,
              model: effectiveModel,
              descriptor: source.descriptor,
              maxTokens: effectiveMaxTokens
            }
          };
        } catch (error) {
          lastTierError = error;
          lastTierClass = classifyTierError(error);
          // Same-tier retry only for transient network blips, and only if we
          // have a retry slot left.
          if (lastTierClass === 'transient' && attempt < MAX_TIER_ATTEMPTS) {
            logger.warn(`[Supervisor] tier transient retry | tier=${source.tierKey} | attempt=${attempt + 1}/${MAX_TIER_ATTEMPTS} | reason=${String(error?.message || error).slice(0, 200)}`);
            await sleep(backoffDelayMs(attempt));
            continue;
          }
          break;
        }
      }

      if (!succeeded && lastTierError) {
        const message = lastTierError?.message || String(lastTierError);
        let breakerState;
        if (lastTierClass === 'permanent') {
          // Configuration-class fault — disable the tier so it doesn't keep
          // tripping breakers on healthier neighbors. The user has to fix
          // the binding (or hit the reset-breaker UI) to re-enable it.
          breakerState = this._breaker.disable(source.tierKey, message);
        } else {
          breakerState = this._breaker.recordFailure(source.tierKey);
        }
        failures.push(`${source.label}: ${message}`);
        logger.warn(`[Supervisor] tier failed | tier=${source.tierKey} | breaker=${breakerState} | class=${lastTierClass} | reason=${message.slice(0, 200)}`);
      }
    }

    this._lastFallbackReason = `all_supervisor_tiers_failed: ${failures.join(' | ')}`;
    throw new Error(`All assistant model sources failed: ${failures.join(' | ')}`);
  }
}

export const assistantLlmClient = new AssistantLlmClient();

export default assistantLlmClient;
