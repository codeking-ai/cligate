import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalConfigDir = process.env.CLIGATE_CONFIG_DIR;
const originalFetch = global.fetch;

async function importFreshAccountManager() {
  return import(`../../src/antigravity-account-manager.js?test=${Date.now()}-${Math.random()}`);
}

test('addOAuthAccount persists oauth client config for future refreshes', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'cligate-antigravity-oauth-'));
  process.env.CLIGATE_CONFIG_DIR = configDir;

  const calls = [];
  global.fetch = async (url) => {
    const target = String(url);
    calls.push(target);

    if (target.includes('/userinfo')) {
      return new Response(JSON.stringify({
        email: 'antigravity@example.com',
        name: 'Anti Gravity',
        picture: 'https://example.com/avatar.png'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (target.includes(':loadCodeAssist')) {
      return new Response(JSON.stringify({
        cloudaicompanionProject: 'project-123',
        subscriptionTier: 'enterprise'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (target.includes(':fetchAvailableModels')) {
      return new Response(JSON.stringify({
        models: [
          { name: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const manager = await importFreshAccountManager();
    const result = await manager.addOAuthAccount({
      accessToken: 'access-token-1',
      refreshToken: 'refresh-token-1',
      expiresIn: 3600,
      oauthClientKey: 'antigravity-enterprise',
      oauthClientConfig: {
        key: 'antigravity-enterprise',
        clientId: 'oauth-client-id',
        clientSecret: 'oauth-client-secret'
      }
    });

    assert.equal(result.success, true);
    const stored = manager.getAccount('antigravity@example.com');
    assert.equal(stored.oauthClientKey, 'antigravity-enterprise');
    assert.deepEqual(stored.oauthClientConfig, {
      key: 'antigravity-enterprise',
      clientId: 'oauth-client-id',
      clientSecret: 'oauth-client-secret'
    });
  } finally {
    global.fetch = originalFetch;
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('addOAuthAccount tolerates missing cloudaicompanionProject and still persists account', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'cligate-antigravity-projectless-'));
  process.env.CLIGATE_CONFIG_DIR = configDir;

  global.fetch = async (url) => {
    const target = String(url);

    if (target.includes('/userinfo')) {
      return new Response(JSON.stringify({
        email: 'projectless@example.com',
        name: 'Projectless User'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (target.includes(':loadCodeAssist')) {
      return new Response(JSON.stringify({
        currentTier: { name: 'free' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (target.includes(':fetchAvailableModels')) {
      return new Response(JSON.stringify({
        models: {
          'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro' }
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const manager = await importFreshAccountManager();
    const result = await manager.addOAuthAccount({
      accessToken: 'access-token-projectless',
      refreshToken: 'refresh-token-projectless',
      expiresIn: 3600
    });

    assert.equal(result.success, true);
    const stored = manager.getAccount('projectless@example.com');
    assert.equal(stored.projectId, null);
    assert.equal(stored.subscriptionType, 'free');
    assert.equal(Array.isArray(stored.models), true);
    assert.equal(stored.models.length, 1);
  } finally {
    global.fetch = originalFetch;
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('refreshAccountToken uses stored oauth client config when refreshing antigravity tokens', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'cligate-antigravity-refresh-'));
  process.env.CLIGATE_CONFIG_DIR = configDir;

  let tokenRequestBody = null;
  global.fetch = async (url, options = {}) => {
    const target = String(url);

    if (target.includes('oauth2.googleapis.com/token')) {
      tokenRequestBody = new URLSearchParams(options.body);
      return new Response(JSON.stringify({
        access_token: 'refreshed-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (target.includes('/userinfo')) {
      return new Response(JSON.stringify({
        email: 'antigravity@example.com',
        name: 'Anti Gravity',
        picture: 'https://example.com/avatar.png'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (target.includes(':loadCodeAssist')) {
      return new Response(JSON.stringify({
        cloudaicompanionProject: 'project-456',
        subscriptionTier: 'enterprise'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (target.includes(':fetchAvailableModels')) {
      return new Response(JSON.stringify({
        models: [
          { name: 'claude-opus-4-6-thinking', displayName: 'Claude Opus 4.6 Thinking' }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    throw new Error(`Unexpected fetch: ${target}`);
  };

  try {
    const manager = await importFreshAccountManager();
    await manager.addManualAccount({
      refreshToken: 'refresh-token-1',
      email: 'antigravity@example.com',
      oauthClientKey: 'antigravity-enterprise',
      oauthClientConfig: {
        key: 'antigravity-enterprise',
        clientId: 'stored-client-id',
        clientSecret: 'stored-client-secret'
      }
    });

    tokenRequestBody = null;
    const result = await manager.refreshAccountToken('antigravity@example.com');

    assert.equal(result.success, true);
    assert.equal(tokenRequestBody.get('client_id'), 'stored-client-id');
    assert.equal(tokenRequestBody.get('client_secret'), 'stored-client-secret');

    const stored = manager.getAccount('antigravity@example.com');
    assert.equal(stored.refreshToken, 'rotated-refresh-token');
    assert.deepEqual(stored.oauthClientConfig, {
      key: 'antigravity-enterprise',
      clientId: 'stored-client-id',
      clientSecret: 'stored-client-secret'
    });
  } finally {
    global.fetch = originalFetch;
    rmSync(configDir, { recursive: true, force: true });
  }
});

test.after(() => {
  if (originalConfigDir === undefined) {
    delete process.env.CLIGATE_CONFIG_DIR;
  } else {
    process.env.CLIGATE_CONFIG_DIR = originalConfigDir;
  }
  global.fetch = originalFetch;
});
