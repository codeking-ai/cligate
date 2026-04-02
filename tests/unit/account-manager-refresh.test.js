import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalFetch = global.fetch;

function encodeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

function createAccount({ email = 'user@example.com', refreshToken = 'refresh-1', expOffsetSec = -60 } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const accessToken = encodeJwt({
    exp: nowSec + expOffsetSec,
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-123',
      chatgpt_plan_type: 'pro',
      chatgpt_user_id: 'user-123'
    },
    'https://api.openai.com/profile': {
      email
    }
  });

  return {
    email,
    accountId: 'acct-123',
    planType: 'pro',
    accessToken,
    refreshToken,
    idToken: null,
    expiresAt: (nowSec + expOffsetSec) * 1000,
    addedAt: new Date().toISOString(),
    lastUsed: new Date().toISOString()
  };
}

async function importFreshAccountManager() {
  return import(`../../src/account-manager.js?test=${Date.now()}-${Math.random()}`);
}

function writeAccountsFile(homeDir, accounts) {
  const configDir = join(homeDir, '.proxypool-hub');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'accounts.json'), JSON.stringify({
    accounts,
    activeAccount: accounts[0]?.email || null,
    version: 1
  }, null, 2));
}

test('refreshAccountToken deduplicates concurrent refreshes per account', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'proxypool-hub-refresh-'));
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  writeAccountsFile(homeDir, [createAccount()]);

  let refreshCalls = 0;
  global.fetch = async (url, options) => {
    const target = typeof url === 'string' ? url : String(url);

    if (target.includes('/oauth/token')) {
      refreshCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 30));
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('refresh_token'), 'refresh-1');

      const refreshedAccessToken = encodeJwt({
        exp: Math.floor(Date.now() / 1000) + 3600,
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct-123',
          chatgpt_plan_type: 'pro',
          chatgpt_user_id: 'user-123'
        },
        'https://api.openai.com/profile': {
          email: 'user@example.com'
        }
      });

      return new Response(JSON.stringify({
        access_token: refreshedAccessToken,
        refresh_token: 'refresh-2',
        expires_in: 3600
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (target.includes('/wham/usage')) {
      return new Response(JSON.stringify({
        plan_type: 'pro',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 10,
            reset_at: Math.floor(Date.now() / 1000) + 3600
          }
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (target.includes('/wham/accounts/check')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const manager = await importFreshAccountManager();
    const [a, b] = await Promise.all([
      manager.refreshAccountToken('user@example.com'),
      manager.refreshAccountToken('user@example.com')
    ]);

    assert.equal(a.success, true);
    assert.equal(b.success, true);
    assert.equal(refreshCalls, 1);

    const refreshed = manager.getAccount('user@example.com');
    assert.equal(refreshed.refreshToken, 'refresh-2');
  } finally {
    global.fetch = originalFetch;
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('refreshAccountToken treats refresh_token_reused as success when another refresh already persisted new token', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'proxypool-hub-refresh-'));
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  const account = createAccount({ refreshToken: 'refresh-stale' });
  writeAccountsFile(homeDir, [account]);

  let refreshCalls = 0;
  global.fetch = async (url, options) => {
    const target = typeof url === 'string' ? url : String(url);

    if (target.includes('/oauth/token')) {
      refreshCalls += 1;
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('refresh_token'), 'refresh-stale');

      const rotatedAccount = createAccount({ refreshToken: 'refresh-new', expOffsetSec: 3600 });
      writeAccountsFile(homeDir, [rotatedAccount]);

      return new Response(JSON.stringify({
        error: {
          message: 'already used',
          code: 'refresh_token_reused'
        }
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const manager = await importFreshAccountManager();
    const result = await manager.refreshAccountToken('user@example.com');

    assert.equal(result.success, true);
    assert.equal(refreshCalls, 1);

    const refreshed = manager.getAccount('user@example.com');
    assert.equal(refreshed.refreshToken, 'refresh-new');
  } finally {
    global.fetch = originalFetch;
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('refreshAccountStatus refreshes quota without rotating token when access token is still valid', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'proxypool-hub-refresh-'));
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  writeAccountsFile(homeDir, [createAccount({ refreshToken: 'refresh-still-valid', expOffsetSec: 3600 })]);

  let oauthCalls = 0;
  let usageCalls = 0;
  global.fetch = async (url) => {
    const target = typeof url === 'string' ? url : String(url);

    if (target.includes('/oauth/token')) {
      oauthCalls += 1;
      throw new Error('oauth/token should not be called for healthy tokens');
    }

    if (target.includes('/wham/usage')) {
      usageCalls += 1;
      return new Response(JSON.stringify({
        plan_type: 'plus',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 25,
            reset_at: Math.floor(Date.now() / 1000) + 7200
          }
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (target.includes('/wham/accounts/check')) {
      return new Response(JSON.stringify({
        accounts: [{ id: 'acct-123', plan_type: 'plus' }],
        default_account_id: 'acct-123'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const manager = await importFreshAccountManager();
    const result = await manager.refreshAccountStatus('user@example.com');

    assert.equal(result.success, true);
    assert.equal(oauthCalls, 0);
    assert.equal(usageCalls, 1);

    const refreshed = manager.getAccount('user@example.com');
    assert.equal(refreshed.planType, 'plus');
    assert.equal(refreshed.quota?.usage?.percentage, 25);
  } finally {
    global.fetch = originalFetch;
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('refreshAccountToken caches permanent refresh token failure for the same stored token', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'proxypool-hub-refresh-'));
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  writeAccountsFile(homeDir, [createAccount({ refreshToken: 'refresh-dead', expOffsetSec: -60 })]);

  let oauthCalls = 0;
  global.fetch = async (url) => {
    const target = typeof url === 'string' ? url : String(url);

    if (target.includes('/oauth/token')) {
      oauthCalls += 1;
      return new Response(JSON.stringify({
        error: {
          message: 'already used',
          code: 'refresh_token_reused'
        }
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const manager = await importFreshAccountManager();

    const first = await manager.refreshAccountToken('user@example.com');
    const second = await manager.refreshAccountToken('user@example.com');

    assert.equal(first.success, false);
    assert.equal(second.success, false);
    assert.equal(oauthCalls, 1);
    assert.match(first.message, /sign in again|re-import/i);
    assert.match(second.message, /sign in again|re-import/i);

    const refreshed = manager.getAccount('user@example.com');
    assert.equal(refreshed.refreshFailure?.code, 'refresh_token_reused');
  } finally {
    global.fetch = originalFetch;
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test.after(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }

  global.fetch = originalFetch;
});
