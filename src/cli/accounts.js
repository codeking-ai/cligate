#!/usr/bin/env node

import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { spawn } from 'child_process';
import net from 'net';
import { homedir } from 'os';
import { join } from 'path';
import crypto from 'crypto';

const CONFIG_DIR = join(homedir(), '.proxypool-hub');
const ACCOUNTS_FILE = join(CONFIG_DIR, 'accounts.json');
const DEFAULT_PORT = 8081;

const OAUTH_CONFIG = {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    callbackPort: 1455,
    callbackPath: '/auth/callback'
};

function loadAccounts() {
    try {
        if (existsSync(ACCOUNTS_FILE)) {
            const data = readFileSync(ACCOUNTS_FILE, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error loading accounts:', error.message);
    }
    return { accounts: [], activeAccount: null, version: 1 };
}

function saveAccounts(data) {
    try {
        const dir = dirname(ACCOUNTS_FILE);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
        console.log(`\n✓ Saved ${data.accounts.length} account(s) to ${ACCOUNTS_FILE}`);
    } catch (error) {
        console.error('Error saving accounts:', error.message);
        throw error;
    }
}

function displayAccounts(data) {
    if (!data.accounts || data.accounts.length === 0) {
        console.log('\nNo accounts configured.');
        return;
    }

    console.log(`\n${data.accounts.length} account(s) saved:`);
    data.accounts.forEach((acc, i) => {
        const active = acc.email === data.activeAccount ? ' (ACTIVE)' : '';
        console.log(`  ${i + 1}. ${acc.email}${active}`);
    });
}

function generatePKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');
    return { verifier, challenge };
}

function generateState() {
    return crypto.randomBytes(16).toString('hex');
}

function getAuthorizationUrl(verifier, state, port) {
    const challenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');
    
    const redirectUri = `http://localhost:${port}${OAUTH_CONFIG.callbackPath}`;
    
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: OAUTH_CONFIG.clientId,
        redirect_uri: redirectUri,
        scope: OAUTH_CONFIG.scopes.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: state,
        prompt: 'login',
        max_age: '0'
    });
    
    return `${OAUTH_CONFIG.authUrl}?${params.toString()}`;
}

function decodeJWT(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const payload = Buffer.from(parts[1], 'base64').toString('utf8');
        return JSON.parse(payload);
    } catch (e) {
        return null;
    }
}

function extractAccountInfo(accessToken) {
    const payload = decodeJWT(accessToken);
    if (!payload) return null;
    
    const authInfo = payload['https://api.openai.com/auth'] || {};
    const profileInfo = payload['https://api.openai.com/profile'] || {};
    
    return {
        accountId: authInfo.chatgpt_account_id || null,
        planType: authInfo.chatgpt_plan_type || 'free',
        userId: authInfo.chatgpt_user_id || payload.sub || null,
        email: profileInfo.email || payload.email || null,
        expiresAt: payload.exp ? payload.exp * 1000 : null
    };
}

async function exchangeCodeForTokens(code, verifier, port) {
    const redirectUri = `http://localhost:${port}${OAUTH_CONFIG.callbackPath}`;
    
    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: redirectUri,
            client_id: OAUTH_CONFIG.clientId,
            code_verifier: verifier
        })
    });
    
    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${response.status} - ${error}`);
    }
    
    const tokens = await response.json();
    
    return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        expiresIn: tokens.expires_in
    };
}

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

            if (error) {
                throw new Error(`OAuth error: ${error}`);
            }

            if (!code) {
                throw new Error('No authorization code found in URL');
            }

            return { code, state };
        } catch (e) {
            if (e.message.includes('OAuth error') || e.message.includes('No authorization code')) {
                throw e;
            }
            throw new Error('Invalid URL format');
        }
    }

    if (trimmed.length < 10) {
        throw new Error('Input is too short to be a valid authorization code');
    }

    return { code: trimmed, state: null };
}

function openBrowser(url) {
    const platform = process.platform;
    let command;
    let args;

    if (platform === 'darwin') {
        command = 'open';
        args = [url];
    } else if (platform === 'win32') {
        command = 'cmd';
        args = ['/c', 'start', '', url.replace(/&/g, '^&')];
    } else {
        command = 'xdg-open';
        args = [url];
    }

    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
        console.log('\n⚠ Could not open browser automatically.');
        console.log('Please open this URL manually:', url);
    });
    child.unref();
}

function isServerRunning(port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);

        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });

        socket.on('error', () => {
            socket.destroy();
            resolve(false);
        });

        socket.connect(port, 'localhost');
    });
}

async function ensureServerStopped(port) {
    const isRunning = await isServerRunning(port);
    if (isRunning) {
        console.error(`
\x1b[31mError: Proxy server is currently running on port ${port}.\x1b[0m

Please stop the server (Ctrl+C) before adding or managing accounts.
This ensures that your account changes are loaded correctly.
`);
        process.exit(1);
    }
}

function createRL() {
    return createInterface({ input: stdin, output: stdout });
}

async function addAccountManual(rl) {
    console.log('\n=== Add ChatGPT Account (No-Browser Mode) ===\n');
    
    const { verifier } = generatePKCE();
    const state = generateState();
    const url = getAuthorizationUrl(verifier, state, OAUTH_CONFIG.callbackPort);

    console.log('Copy the following URL and open it in a browser on another device:\n');
    console.log(`   ${url}\n`);
    console.log('After signing in, you will be redirected to a localhost URL.');
    console.log('Copy the ENTIRE redirect URL or just the authorization code.\n');

    const input = await rl.question('Paste the callback URL or authorization code: ');

    try {
        const { code, state: extractedState } = extractCodeFromInput(input);

        if (extractedState && extractedState !== state) {
            console.log('\n⚠ State mismatch detected. This could indicate a security issue.');
            console.log('Proceeding anyway as this is manual mode...');
        }

        console.log('\nExchanging authorization code for tokens...');
        const tokens = await exchangeCodeForTokens(code, verifier, OAUTH_CONFIG.callbackPort);
        const accountInfo = extractAccountInfo(tokens.accessToken);

        const data = loadAccounts();
        
        const existingIndex = data.accounts.findIndex(a => a.email === accountInfo?.email);
        const newAccount = {
            email: accountInfo?.email || 'unknown',
            accountId: accountInfo?.accountId,
            planType: accountInfo?.planType || 'free',
            refreshToken: tokens.refreshToken,
            addedAt: new Date().toISOString(),
            lastUsed: null
        };

        if (existingIndex >= 0) {
            data.accounts[existingIndex] = newAccount;
            console.log(`\n⚠ Account ${newAccount.email} already exists. Updating tokens.`);
        } else {
            data.accounts.push(newAccount);
            if (!data.activeAccount) {
                data.activeAccount = newAccount.email;
            }
        }

        saveAccounts(data);
        console.log(`\n✓ Successfully authenticated: ${newAccount.email}`);
        
    } catch (error) {
        console.error(`\n✗ Authentication failed: ${error.message}`);
    }
}

async function addAccountBrowser(rl) {
    console.log('\n=== Add ChatGPT Account ===\n');

    const { verifier } = generatePKCE();
    const state = generateState();
    const url = getAuthorizationUrl(verifier, state, OAUTH_CONFIG.callbackPort);

    console.log('Opening browser for ChatGPT sign-in...');
    console.log('(If browser does not open, copy this URL manually)\n');
    console.log(`   ${url}\n`);

    openBrowser(url);

    console.log('After authorization, paste the callback URL or code here.\n');
    
    const input = await rl.question('Paste the callback URL or authorization code: ');

    try {
        const { code, state: extractedState } = extractCodeFromInput(input);

        if (extractedState && extractedState !== state) {
            console.log('\n⚠ State mismatch detected. This could indicate a security issue.');
            console.log('Proceeding anyway...');
        }

        console.log('\nExchanging authorization code for tokens...');
        const tokens = await exchangeCodeForTokens(code, verifier, OAUTH_CONFIG.callbackPort);
        const accountInfo = extractAccountInfo(tokens.accessToken);

        const data = loadAccounts();
        
        const existingIndex = data.accounts.findIndex(a => a.email === accountInfo?.email);
        const newAccount = {
            email: accountInfo?.email || 'unknown',
            accountId: accountInfo?.accountId,
            planType: accountInfo?.planType || 'free',
            refreshToken: tokens.refreshToken,
            addedAt: new Date().toISOString(),
            lastUsed: null
        };

        if (existingIndex >= 0) {
            data.accounts[existingIndex] = newAccount;
            console.log(`\n⚠ Account ${newAccount.email} already exists. Updating tokens.`);
        } else {
            data.accounts.push(newAccount);
            if (!data.activeAccount) {
                data.activeAccount = newAccount.email;
            }
        }

        saveAccounts(data);
        console.log(`\n✓ Successfully authenticated: ${newAccount.email}`);
        
    } catch (error) {
        console.error(`\n✗ Authentication failed: ${error.message}`);
    }
}

async function listAccounts() {
    const data = loadAccounts();
    displayAccounts(data);
    if (data.accounts.length > 0) {
        console.log(`\nConfig file: ${ACCOUNTS_FILE}`);
    }
}

async function clearAccounts(rl) {
    const data = loadAccounts();

    if (!data.accounts || data.accounts.length === 0) {
        console.log('No accounts to clear.');
        return;
    }

    displayAccounts(data);

    const confirm = await rl.question('\nAre you sure you want to remove all accounts? [y/N]: ');
    if (confirm.toLowerCase() === 'y') {
        data.accounts = [];
        data.activeAccount = null;
        saveAccounts(data);
        console.log('All accounts removed.');
    } else {
        console.log('Cancelled.');
    }
}

async function interactiveRemove(rl) {
    while (true) {
        const data = loadAccounts();
        if (!data.accounts || data.accounts.length === 0) {
            console.log('\nNo accounts to remove.');
            return;
        }

        displayAccounts(data);
        console.log('\nEnter account number to remove (or 0 to cancel)');

        const answer = await rl.question('> ');
        const index = parseInt(answer, 10);

        if (isNaN(index) || index < 0 || index > data.accounts.length) {
            console.log('\n❌ Invalid selection.');
            continue;
        }

        if (index === 0) {
            return;
        }

        const removed = data.accounts[index - 1];
        const confirm = await rl.question(`\nAre you sure you want to remove ${removed.email}? [y/N]: `);

        if (confirm.toLowerCase() === 'y') {
            data.accounts.splice(index - 1, 1);
            if (data.activeAccount === removed.email) {
                data.activeAccount = data.accounts[0]?.email || null;
            }
            saveAccounts(data);
            console.log(`\n✓ Removed ${removed.email}`);
        } else {
            console.log('\nCancelled.');
        }

        if (data.accounts.length === 0) {
            return;
        }

        const removeMore = await rl.question('\nRemove another account? [y/N]: ');
        if (removeMore.toLowerCase() !== 'y') {
            break;
        }
    }
}

async function verifyAccounts() {
    const data = loadAccounts();

    if (!data.accounts || data.accounts.length === 0) {
        console.log('No accounts to verify.');
        return;
    }

    console.log('\nVerifying accounts...\n');

    for (const account of data.accounts) {
        try {
            const response = await fetch(OAUTH_CONFIG.tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: account.refreshToken,
                    client_id: OAUTH_CONFIG.clientId
                })
            });

            if (response.ok) {
                console.log(`  ✓ ${account.email} - OK`);
            } else {
                const error = await response.text();
                console.log(`  ✗ ${account.email} - ${response.status}: ${error}`);
            }
        } catch (error) {
            console.log(`  ✗ ${account.email} - ${error.message}`);
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'help';
    const noBrowser = args.includes('--no-browser');
    const port = parseInt(args.find(a => a.startsWith('--port='))?.split('=')[1]) || DEFAULT_PORT;

    console.log('╔════════════════════════════════════════╗');
    console.log('║   ProxyPool Hub Account Manager       ║');
    console.log('║   Use --no-browser for headless mode   ║');
    console.log('╚════════════════════════════════════════╝');

    const rl = createRL();

    try {
        switch (command) {
            case 'add':
                if (noBrowser) {
                    await addAccountManual(rl);
                } else {
                    await ensureServerStopped(port);
                    await addAccountBrowser(rl);
                }
                break;
            case 'list':
                await listAccounts();
                break;
            case 'remove':
                await ensureServerStopped(port);
                await interactiveRemove(rl);
                break;
            case 'verify':
                await verifyAccounts();
                break;
            case 'clear':
                await ensureServerStopped(port);
                await clearAccounts(rl);
                break;
            case 'help':
            default:
                console.log('\nUsage:');
                console.log('  proxypool-hub accounts add           Add account (opens browser)');
                console.log('  proxypool-hub accounts add --no-browser  Add account (manual code)');
                console.log('  proxypool-hub accounts list         List all accounts');
                console.log('  proxypool-hub accounts remove       Remove accounts interactively');
                console.log('  proxypool-hub accounts verify       Verify account tokens');
                console.log('  proxypool-hub accounts clear        Remove all accounts');
                console.log('  proxypool-hub accounts help         Show this help');
                console.log('\nOptions:');
                console.log('  --no-browser    Manual authorization code input (for headless/VM servers)');
                console.log('  --port=<port>   Server port (default: 8081)');
                console.log('\nHeadless/VM Usage:');
                console.log('  1. Run: proxypool-hub accounts add --no-browser');
                console.log('  2. Copy the URL shown and open in browser on another device');
                console.log('  3. After login, paste the callback URL back in terminal');
                break;
        }
    } finally {
        rl.close();
        process.exit(0);
    }
}

main().catch(console.error);