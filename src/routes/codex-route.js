/**
 * Codex Passthrough Route
 * Handles POST /backend-api/codex/responses
 *
 * Proxies requests from Codex CLI directly to ChatGPT's backend API
 * with multi-account rotation. No format conversion is needed because
 * Codex CLI already speaks the OpenAI Responses API format natively.
 */

import { AccountRotator } from '../account-rotation/index.js';
import { listAccounts, getActiveAccount, save } from '../account-manager.js';
import { getCredentialsForAccount } from '../middleware/credentials.js';
import { logger } from '../utils/logger.js';
import { getServerSettings } from '../server-settings.js';
import { fetchModels } from '../model-api.js';

const UPSTREAM_BASE = 'https://chatgpt.com/backend-api';
const MAX_RETRIES = 5;
const MAX_WAIT_BEFORE_ERROR_MS = 120000;
const SHORT_RATE_LIMIT_THRESHOLD_MS = 5000;

let accountRotator = null;
let currentStrategy = null;

function getAccountRotator() {
    const settings = getServerSettings();
    const strategy = settings.accountStrategy || 'sticky';

    if (!accountRotator || currentStrategy !== strategy) {
        accountRotator = new AccountRotator({
            listAccounts,
            save,
            getActiveAccount
        }, strategy);
        currentStrategy = strategy;
        logger.info(`[Codex] Account strategy: ${strategy}`);
    }
    return accountRotator;
}

function parseResetTime(response, errorText) {
    const retryAfter = response.headers?.get?.('retry-after');
    if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) return seconds * 1000;
    }

    const ratelimitReset = response.headers?.get?.('x-ratelimit-reset');
    if (ratelimitReset) {
        const timestamp = parseInt(ratelimitReset, 10) * 1000;
        const wait = timestamp - Date.now();
        if (wait > 0) return wait;
    }

    if (errorText) {
        const delayMatch = errorText.match(/quotaResetDelay[:\s"]+(\d+(?:\.\d+)?)(ms|s)/i);
        if (delayMatch) {
            const value = parseFloat(delayMatch[1]);
            return delayMatch[2] === 's' ? value * 1000 : value;
        }

        const secMatch = errorText.match(/retry\s+(?:after\s+)?(\d+)\s*(?:sec|s\b)/i);
        if (secMatch) {
            return parseInt(secMatch[1], 10) * 1000;
        }
    }

    return 60000;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * POST /backend-api/codex/responses
 * Transparent proxy with account rotation for Codex CLI.
 */
export async function handleCodexResponses(req, res) {
    const startTime = Date.now();
    const body = req.body;
    const modelId = body.model || 'gpt-5.2';
    const isStreaming = body.stream !== false;

    // --- Request logging ---
    const inputSummary = Array.isArray(body.input)
        ? body.input.map(item => {
            if (item.type === 'message') {
                const text = typeof item.content === 'string'
                    ? item.content
                    : Array.isArray(item.content)
                        ? item.content.map(c => c.text || c.type).join(', ')
                        : JSON.stringify(item.content);
                return `[${item.role}] ${text.slice(0, 120)}${text.length > 120 ? '...' : ''}`;
            }
            if (item.type === 'function_call') return `[tool_call] ${item.name}(...)`;
            if (item.type === 'function_call_output') return `[tool_result] ${(item.output || '').slice(0, 80)}...`;
            return `[${item.type}]`;
        })
        : [];
    const toolNames = Array.isArray(body.tools) ? body.tools.map(t => t.name || t.function?.name).filter(Boolean) : [];

    console.log('\n' + '='.repeat(70));
    console.log(`[Codex Proxy] >>> REQUEST RECEIVED`);
    console.log(`  Model:     ${modelId}`);
    console.log(`  Stream:    ${isStreaming}`);
    console.log(`  Tools:     ${toolNames.length > 0 ? toolNames.join(', ') : '(none)'}`);
    if (body.instructions) {
        console.log(`  System:    ${body.instructions.slice(0, 150)}${body.instructions.length > 150 ? '...' : ''}`);
    }
    console.log(`  Messages (${inputSummary.length}):`);
    for (const line of inputSummary.slice(-5)) {
        console.log(`    ${line}`);
    }
    if (inputSummary.length > 5) {
        console.log(`    ... (${inputSummary.length - 5} earlier messages omitted)`);
    }
    console.log('='.repeat(70));

    const rotator = getAccountRotator();
    rotator.clearExpiredLimits();

    const maxAttempts = Math.max(MAX_RETRIES, listAccounts().total);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Check if all accounts are rate-limited
        if (rotator.isAllRateLimited(modelId)) {
            const minWait = rotator.getMinWaitTimeMs(modelId);

            if (minWait > MAX_WAIT_BEFORE_ERROR_MS) {
                return sendCodexError(res, 429, `All accounts rate-limited. Wait ${Math.round(minWait / 1000)}s`);
            }

            logger.info(`[Codex] All accounts rate-limited, waiting ${Math.round(minWait / 1000)}s...`);
            await sleep(minWait + 500);
            rotator.clearExpiredLimits();
            attempt--;
            continue;
        }

        const { account, waitMs } = rotator.selectAccount(modelId);

        if (!account) {
            if (waitMs > 0) {
                await sleep(waitMs);
                attempt--;
                continue;
            }
            return sendCodexError(res, 401, 'No available accounts. Add accounts via the proxy dashboard.');
        }

        const creds = await getCredentialsForAccount(account.email);
        if (!creds) {
            rotator.markInvalid(account.email, 'Failed to get credentials');
            continue;
        }

        console.log(`[Codex Proxy] >>> FORWARDING to ChatGPT | account=${creds.email} | model=${modelId} | attempt=${attempt + 1}`);

        try {
            const upstreamResponse = await fetch(`${UPSTREAM_BASE}/codex/responses`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${creds.accessToken}`,
                    'ChatGPT-Account-ID': creds.accountId,
                    'Content-Type': 'application/json',
                    'Accept': isStreaming ? 'text/event-stream' : 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (!upstreamResponse.ok) {
                const errorText = await upstreamResponse.text();

                if (upstreamResponse.status === 401) {
                    rotator.markInvalid(creds.email, 'Token expired or revoked');
                    rotator.notifyFailure(account, modelId);
                    logger.warn(`[Codex] Auth expired for ${creds.email}, trying next...`);
                    continue;
                }

                if (upstreamResponse.status === 429) {
                    const resetMs = parseResetTime(upstreamResponse, errorText);
                    rotator.markRateLimited(creds.email, resetMs, modelId);
                    rotator.notifyRateLimit(account, modelId);

                    if (resetMs <= SHORT_RATE_LIMIT_THRESHOLD_MS) {
                        logger.info(`[Codex] Short rate limit on ${creds.email}, waiting ${resetMs}ms...`);
                        await sleep(resetMs);
                        attempt--;
                        continue;
                    }

                    logger.info(`[Codex] Rate limited on ${creds.email} (${Math.round(resetMs / 1000)}s), switching account...`);
                    continue;
                }

                // Other errors: return to client
                logger.error(`[Codex] Upstream error ${upstreamResponse.status}: ${errorText.slice(0, 200)}`);
                return res.status(upstreamResponse.status)
                    .set('Content-Type', 'application/json')
                    .send(errorText);
            }

            // Success — stream or send response back
            rotator.notifySuccess(account, modelId);

            if (isStreaming) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();

                const reader = upstreamResponse.body.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        res.write(value);
                    }
                } catch (streamErr) {
                    logger.error(`[Codex] Stream error: ${streamErr.message}`);
                } finally {
                    res.end();
                }
            } else {
                const responseBody = await upstreamResponse.text();
                res.setHeader('Content-Type', 'application/json');
                res.send(responseBody);
            }

            const duration = Date.now() - startTime;
            console.log(`[Codex Proxy] <<< RESPONSE OK | account=${creds.email} | model=${modelId} | ${duration}ms`);
            return;
        } catch (error) {
            logger.error(`[Codex] Network error on ${creds.email}: ${error.message}`);
            rotator.notifyFailure(account, modelId);
            continue;
        }
    }

    return sendCodexError(res, 503, 'Max retries exceeded. All accounts failed.');
}

/**
 * GET /backend-api/codex/models
 * Proxies model listing with account rotation.
 */
export async function handleCodexModels(req, res) {
    const creds = await _getAnyCreds();

    if (!creds) {
        return sendCodexError(res, 401, 'No available accounts');
    }

    const clientVersion = req.query.client_version || '0.116.0';
    const url = `${UPSTREAM_BASE}/codex/models?client_version=${clientVersion}`;

    try {
        const upstreamResponse = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${creds.accessToken}`,
                'ChatGPT-Account-ID': creds.accountId,
                'Accept': 'application/json'
            }
        });

        if (!upstreamResponse.ok) {
            const errorText = await upstreamResponse.text();
            logger.error(`[Codex] Models fetch failed: ${upstreamResponse.status}`);
            return res.status(upstreamResponse.status)
                .set('Content-Type', 'application/json')
                .send(errorText);
        }

        const responseBody = await upstreamResponse.text();
        res.setHeader('Content-Type', 'application/json');
        res.send(responseBody);
    } catch (error) {
        logger.error(`[Codex] Models fetch error: ${error.message}`);
        return sendCodexError(res, 502, `Failed to fetch models: ${error.message}`);
    }
}

/**
 * Catch-all proxy for other /backend-api/* requests Codex may send.
 * Forwards to upstream with pool credentials.
 */
export async function handleCodexCatchAll(req, res) {
    const creds = await _getAnyCreds();

    if (!creds) {
        return sendCodexError(res, 401, 'No available accounts');
    }

    const upstreamPath = req.originalUrl; // preserves query string
    const url = `https://chatgpt.com${upstreamPath}`;

    logger.info(`[Codex] Proxy ${req.method} ${upstreamPath} via ${creds.email}`);

    try {
        const headers = {
            'Authorization': `Bearer ${creds.accessToken}`,
            'ChatGPT-Account-ID': creds.accountId,
            'Accept': req.headers.accept || 'application/json'
        };

        const fetchOpts = { method: req.method, headers };

        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            headers['Content-Type'] = 'application/json';
            fetchOpts.body = JSON.stringify(req.body);
        }

        const upstreamResponse = await fetch(url, fetchOpts);
        const responseBody = await upstreamResponse.text();

        // Forward status + headers
        res.status(upstreamResponse.status);
        const ct = upstreamResponse.headers.get('content-type');
        if (ct) res.setHeader('Content-Type', ct);
        res.send(responseBody);
    } catch (error) {
        logger.error(`[Codex] Proxy error: ${error.message}`);
        return sendCodexError(res, 502, `Proxy error: ${error.message}`);
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function _getAnyCreds() {
    const rotator = getAccountRotator();
    const { account } = rotator.selectAccount('default');
    if (account) {
        return getCredentialsForAccount(account.email);
    }
    return null;
}

function sendCodexError(res, status, message) {
    return res.status(status).json({
        error: { message, type: 'proxy_error', code: status }
    });
}

export default { handleCodexResponses, handleCodexModels, handleCodexCatchAll };
