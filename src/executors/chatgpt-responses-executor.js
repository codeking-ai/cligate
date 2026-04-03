const API_URL = 'https://chatgpt.com/backend-api/codex/responses';

export function parseResetTime(response, errorText) {
    const retryAfter = response.headers?.get?.('retry-after');
    if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!Number.isNaN(seconds)) return seconds * 1000;
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

async function assertChatGPTResponsesOk(response, { accountRotator = null, currentEmail = null, modelId = null } = {}) {
    if (response.ok) return response;

    const errorText = await response.text();

    if (response.status === 401) {
        if (accountRotator && currentEmail) {
            accountRotator.markInvalid(currentEmail, 'Token expired or revoked');
        }
        throw new Error('AUTH_EXPIRED: Token expired or revoked. Please re-authenticate.');
    }

    if (response.status === 429) {
        const resetMs = parseResetTime(response, errorText);
        if (accountRotator && currentEmail) {
            accountRotator.markRateLimited(currentEmail, resetMs, modelId);
        }
        throw new Error(`RATE_LIMITED:${resetMs}:${errorText}`);
    }

    if (response.status === 403) {
        if (errorText.includes('challenge') || errorText.includes('cloudflare')) {
            throw new Error('CLOUDFLARE_BLOCKED: Request blocked by Cloudflare.');
        }
        throw new Error(`FORBIDDEN: ${errorText}`);
    }

    if (response.status === 400) {
        throw new Error(`INVALID_REQUEST: ${errorText}`);
    }

    throw new Error(`API_ERROR: ${response.status} - ${errorText}`);
}

export async function executeChatGPTResponsesRequest({
    request,
    accessToken,
    accountId,
    modelId,
    accountRotator = null,
    currentEmail = null
}) {
    let response;
    try {
        response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'ChatGPT-Account-ID': accountId,
                'Content-Type': 'application/json',
                Accept: 'text/event-stream'
            },
            body: JSON.stringify(request)
        });
    } catch (fetchError) {
        console.error('[ChatGPTResponsesExecutor] fetch() failed:', fetchError.message);
        throw new Error(`FETCH_ERROR: ${fetchError.message}`);
    }

    await assertChatGPTResponsesOk(response, { accountRotator, currentEmail, modelId });
    return response;
}

export default {
    executeChatGPTResponsesRequest,
    parseResetTime
};
