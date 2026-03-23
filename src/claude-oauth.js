/**
 * Claude OAuth Module
 * Handles OAuth 2.0 with PKCE for Claude/Anthropic authentication
 * Reference: ccproxy-api oauth_claude plugin
 */

import crypto from 'crypto';
import http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Claude OAuth Configuration (from Claude Code / ccproxy-api)
const CLAUDE_OAUTH_CONFIG = {
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
    profileUrl: 'https://api.anthropic.com/api/oauth/profile',
    manualRedirectUri: 'https://console.anthropic.com/oauth/code/callback',
    scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
    callbackPort: 54545,
    callbackFallbackPorts: [54546, 54547, 54548, 54549, 54550],
    callbackPath: '/callback'
};

// Store PKCE verifiers temporarily
const pkceStore = new Map();

/**
 * Generate PKCE code verifier and challenge (S256)
 */
function generatePKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');
    return { verifier, challenge };
}

/**
 * Generate challenge from existing verifier
 */
function generatePKCEFromVerifier(verifier) {
    const challenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');
    return { challenge };
}

/**
 * Generate random state for CSRF protection
 */
function generateState() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * Get Claude authorization URL
 */
function getAuthorizationUrl(verifier, state, port) {
    const { challenge } = generatePKCEFromVerifier(verifier);
    const redirectUri = `http://localhost:${port}${CLAUDE_OAUTH_CONFIG.callbackPath}`;

    pkceStore.set(state, { verifier, port, createdAt: Date.now() });

    // Clean up old entries (>5 min)
    for (const [key, value] of pkceStore.entries()) {
        if (Date.now() - value.createdAt > 5 * 60 * 1000) {
            pkceStore.delete(key);
        }
    }

    const params = new URLSearchParams({
        code: 'true',  // Required by Claude OAuth
        client_id: CLAUDE_OAUTH_CONFIG.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: CLAUDE_OAUTH_CONFIG.scopes.join(' '),
        state: state,
        code_challenge: challenge,
        code_challenge_method: 'S256'
    });

    const url = `${CLAUDE_OAUTH_CONFIG.authUrl}?${params.toString()}`;
    console.log(`[ClaudeOAuth] Generated Authorization URL`);
    return url;
}

/**
 * Get stored PKCE data for a state
 */
function getPKCEData(state) {
    return pkceStore.get(state) || null;
}

/**
 * Success/Error HTML templates
 */
function getSuccessHtml(message) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Claude Auth Success</title>
<style>body{font-family:system-ui;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#1e293b;padding:3rem;border-radius:1rem;box-shadow:0 25px 50px -12px rgba(0,0,0,.5);text-align:center;max-width:400px;border:1px solid #334155}
.icon{font-size:4rem;margin-bottom:1.5rem;display:block}h1{margin:0 0 1rem;color:#a78bfa;font-weight:700}
p{color:#94a3b8;line-height:1.6;font-size:1.1rem}.footer{margin-top:2rem;font-size:.9rem;color:#64748b}</style></head>
<body><div class="card"><span class="icon">✅</span><h1>Success!</h1><p>${message}</p>
<div class="footer">You can close this window.</div></div>
<script>if(window.opener)window.opener.postMessage({type:'claude-oauth-success'},'*');setTimeout(()=>window.close(),3000)</script></body></html>`;
}

function getErrorHtml(error) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Claude Auth Failed</title>
<style>body{font-family:system-ui;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#1e293b;padding:3rem;border-radius:1rem;box-shadow:0 25px 50px -12px rgba(0,0,0,.5);text-align:center;max-width:400px;border:1px solid #334155}
.icon{font-size:4rem;margin-bottom:1.5rem;display:block}h1{margin:0 0 1rem;color:#ef4444;font-weight:700}
p{color:#94a3b8;line-height:1.6;font-size:1.1rem}</style></head>
<body><div class="card"><span class="icon">❌</span><h1>Failed</h1><p>Authentication failed.</p>
<div style="background:rgba(239,68,68,.1);padding:1rem;border-radius:.5rem;color:#fca5a5;margin-top:1rem;font-family:monospace;font-size:.9rem">${error}</div>
<p style="margin-top:1.5rem;font-size:.9rem">Please close this window and try again.</p></div></body></html>`;
}

/**
 * Attempt to bind server to a specific port
 */
function tryBindPort(server, port, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.removeListener('listening', onSuccess);
            reject(err);
        };
        const onSuccess = () => {
            server.removeListener('error', onError);
            resolve(port);
        };
        server.once('error', onError);
        server.once('listening', onSuccess);
        server.listen(port, host);
    });
}

/**
 * Start local callback server for Claude OAuth
 */
function startCallbackServer(expectedState, timeoutMs = 120000) {
    let server = null;
    let timeoutId = null;
    let isAborted = false;
    let actualPort = CLAUDE_OAUTH_CONFIG.callbackPort;
    const host = process.env.HOST || '0.0.0.0';

    const promise = new Promise(async (resolve, reject) => {
        const portsToTry = [CLAUDE_OAUTH_CONFIG.callbackPort, ...(CLAUDE_OAUTH_CONFIG.callbackFallbackPorts || [])];
        const errors = [];

        server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`);

            if (url.pathname !== CLAUDE_OAUTH_CONFIG.callbackPath) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            if (error) {
                console.error(`[ClaudeOAuth] Error in callback: ${error}`);
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(getErrorHtml(error));
                server.close();
                reject(new Error(`Claude OAuth error: ${error}`));
                return;
            }

            if (code) {
                console.log('[ClaudeOAuth] Got authorization code');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(getSuccessHtml('Claude authentication successful! You can close this window.'));

                setTimeout(() => {
                    server.close();
                    clearTimeout(timeoutId);
                    resolve(code);
                }, 1000);
                return;
            }

            res.writeHead(400);
            res.end('Waiting for authorization code...');
        });

        // Try ports with fallback
        let boundSuccessfully = false;
        for (const port of portsToTry) {
            try {
                await tryBindPort(server, port, host);
                actualPort = port;
                boundSuccessfully = true;
                console.log(`[ClaudeOAuth] Callback server listening on ${host}:${port}`);
                break;
            } catch (err) {
                errors.push(`Port ${port}: ${err.code || err.message}`);
            }
        }

        if (!boundSuccessfully) {
            reject(new Error(`Failed to start Claude OAuth callback server. Tried: ${portsToTry.join(', ')}\n${errors.join('\n')}`));
            return;
        }

        timeoutId = setTimeout(() => {
            if (!isAborted) {
                server.close();
                reject(new Error('Claude OAuth callback timeout'));
            }
        }, timeoutMs);
    });

    const abort = () => {
        if (isAborted) return;
        isAborted = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (server) server.close();
        console.log('[ClaudeOAuth] Callback server aborted');
    };

    const getPort = () => actualPort;

    return { promise, abort, getPort };
}

/**
 * Exchange authorization code for Claude tokens
 * Claude uses JSON body (not form-urlencoded) and requires state parameter
 */
async function exchangeCodeForTokens(code, verifier, port, state) {
    const redirectUri = `http://localhost:${port}${CLAUDE_OAUTH_CONFIG.callbackPath}`;

    const body = {
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri,
        client_id: CLAUDE_OAUTH_CONFIG.clientId,
        code_verifier: verifier
    };

    // Claude requires state in token exchange (non-standard)
    if (state) {
        body.state = state;
    }

    const response = await fetch(CLAUDE_OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Claude token exchange failed: ${response.status} - ${error}`);
    }

    const tokens = await response.json();

    if (!tokens.access_token) {
        throw new Error('No access token in Claude response');
    }

    return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
        expiresIn: tokens.expires_in,
        scopes: tokens.scope ? tokens.scope.split(' ') : CLAUDE_OAUTH_CONFIG.scopes,
        subscriptionType: tokens.subscription_type || null
    };
}

/**
 * Refresh Claude access token
 */
async function refreshAccessToken(refreshToken) {
    const response = await fetch(CLAUDE_OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: CLAUDE_OAUTH_CONFIG.clientId
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Claude token refresh failed: ${response.status} - ${error}`);
    }

    const tokens = await response.json();

    return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        expiresIn: tokens.expires_in,
        scopes: tokens.scope ? tokens.scope.split(' ') : [],
        subscriptionType: tokens.subscription_type || null
    };
}

/**
 * Fetch Claude user profile using access token
 * Endpoint: /api/oauth/profile or /api/organizations/me
 */
async function fetchProfile(accessToken) {
    try {
        const response = await fetch(CLAUDE_OAUTH_CONFIG.profileUrl, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            console.warn(`[ClaudeOAuth] Profile fetch failed: ${response.status}`);
            return null;
        }

        const data = await response.json();
        const account = data.account || {};
        const organization = data.organization || {};

        return {
            accountId: account.uuid || null,
            email: account.email || null,
            displayName: account.full_name || null,
            hasClaudePro: account.has_claude_pro || false,
            hasClaudeMax: account.has_claude_max || false,
            organizationName: organization.name || null,
            subscriptionType: account.has_claude_max ? 'max'
                : account.has_claude_pro ? 'pro'
                : 'free',
            raw: data
        };
    } catch (e) {
        console.warn(`[ClaudeOAuth] Profile fetch error: ${e.message}`);
        return null;
    }
}

/**
 * Extract code from user input (URL or raw code)
 */
function extractCodeFromInput(input) {
    if (!input || typeof input !== 'string') {
        throw new Error('No input provided');
    }

    const trimmed = input.trim();

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        try {
            const url = new URL(trimmed);
            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            const error = url.searchParams.get('error');

            if (error) throw new Error(`Claude OAuth error: ${error}`);
            if (!code) throw new Error('No authorization code found in URL');

            return { code, state };
        } catch (e) {
            if (e.message.includes('OAuth error') || e.message.includes('No authorization code')) throw e;
            throw new Error('Invalid URL format');
        }
    }

    if (trimmed.length < 10) {
        throw new Error('Input is too short to be a valid authorization code');
    }

    return { code: trimmed, state: null };
}

/**
 * Open URL in default browser
 */
async function openBrowser(url) {
    const platform = process.platform;
    try {
        if (platform === 'darwin') {
            await execAsync(`open "${url}"`);
        } else if (platform === 'win32') {
            await execAsync(`start "" "${url}"`);
        } else {
            await execAsync(`xdg-open "${url}"`);
        }
    } catch (e) {
        console.log(`[ClaudeOAuth] Could not open browser. Please visit:\n${url}`);
    }
}

/**
 * Handle Claude OAuth callback from web flow
 */
async function handleOAuthCallback(code, state) {
    const pkceData = getPKCEData(state);
    if (!pkceData) {
        throw new Error('Invalid or expired Claude OAuth state');
    }

    const tokens = await exchangeCodeForTokens(code, pkceData.verifier, pkceData.port, state);
    const profile = await fetchProfile(tokens.accessToken);

    // Clean up
    pkceStore.delete(state);

    const expiresAt = tokens.expiresIn
        ? Date.now() + tokens.expiresIn * 1000
        : null;

    return {
        email: profile?.email || 'unknown@claude.ai',
        accountId: profile?.accountId || null,
        displayName: profile?.displayName || null,
        subscriptionType: profile?.subscriptionType || tokens.subscriptionType || 'free',
        hasClaudePro: profile?.hasClaudePro || false,
        hasClaudeMax: profile?.hasClaudeMax || false,
        organizationName: profile?.organizationName || null,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: expiresAt,
        scopes: tokens.scopes
    };
}

export {
    CLAUDE_OAUTH_CONFIG,
    generatePKCE,
    generateState,
    getAuthorizationUrl,
    startCallbackServer,
    exchangeCodeForTokens,
    refreshAccessToken,
    fetchProfile,
    openBrowser,
    handleOAuthCallback,
    getPKCEData,
    extractCodeFromInput
};

export default {
    handleOAuthCallback,
    refreshAccessToken,
    fetchProfile,
    extractCodeFromInput
};
