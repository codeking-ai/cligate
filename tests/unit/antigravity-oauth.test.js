import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateCodeVerifier,
  buildCodeChallenge,
  getAuthorizationUrl,
  exchangeCodeForTokens
} from '../../src/antigravity-oauth.js';

const originalFetch = global.fetch;

test('getAuthorizationUrl adds PKCE challenge parameters for Antigravity OAuth', () => {
  const verifier = generateCodeVerifier();
  const url = new URL(getAuthorizationUrl('state-123', 36545, verifier));

  assert.equal(url.searchParams.get('state'), 'state-123');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), buildCodeChallenge(verifier));
  assert.equal(url.searchParams.get('code_challenge')?.length > 0, true);
});

test('exchangeCodeForTokens uses code_verifier and includes configured client_secret', async () => {
  let body = null;
  global.fetch = async (_url, options = {}) => {
    body = new URLSearchParams(options.body);
    return new Response(JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      token_type: 'Bearer'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await exchangeCodeForTokens('auth-code', 36545, 'pkce-verifier');
    assert.equal(result.accessToken, 'access-token');
    assert.equal(body.get('code_verifier'), 'pkce-verifier');
    assert.equal(body.get('client_secret'), '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');
    assert.equal(body.get('grant_type'), 'authorization_code');
  } finally {
    global.fetch = originalFetch;
  }
});

test.after(() => {
  global.fetch = originalFetch;
});
