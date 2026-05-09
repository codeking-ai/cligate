import './test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = process.env.ROUTING_TEST_BASE_URL || 'http://localhost:8081';
const shouldSkip = process.env.ENABLE_LIVE_SERVER_TESTS !== 'true';

test('CORS: Allows localhost origin', { skip: shouldSkip }, async () => {
  const res = await fetch(`${baseUrl}/health`, {
    method: 'OPTIONS',
    headers: {
      'Origin': 'http://localhost:8081',
      'Access-Control-Request-Method': 'GET'
    }
  });
  
  // CORS middleware should respond with appropriate headers for allowed origin
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:8081');
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET,POST,PUT,DELETE,OPTIONS');
});

test('CORS: Allows 127.0.0.1 origin', { skip: shouldSkip }, async () => {
  const res = await fetch(`${baseUrl}/health`, {
    method: 'OPTIONS',
    headers: {
      'Origin': 'http://127.0.0.1:8081',
      'Access-Control-Request-Method': 'GET'
    }
  });

  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8081');
});

test('CORS: Blocks external origin (malicious-site.com)', { skip: shouldSkip }, async () => {
  const res = await fetch(`${baseUrl}/health`, {
    method: 'OPTIONS', // browser preflight
    headers: {
      'Origin': 'http://malicious-site.com',
      'Access-Control-Request-Method': 'GET'
    }
  });

  // Depending on express and cors setup:
  // Usually, if origin is not allowed, the Access-Control-Allow-Origin header is MISSING.
  // The status might still be 204 (No Content) for OPTIONS, but the browser will reject it due to missing header.
  // Or it might just return the response without CORS headers.
  
  const allowOrigin = res.headers.get('access-control-allow-origin');
  
  // Assert that allow-origin is either missing or NOT the malicious site
  assert.notEqual(allowOrigin, 'http://malicious-site.com');
  
  // If it's strictly handling it, allowOrigin typically won't be present at all for disallowed origins 
  // unless configured to reflect request origin (which is what we fixed to prevent).
});

test('CORS: Blocks null origin', { skip: shouldSkip }, async () => {
  const res = await fetch(`${baseUrl}/health`, {
    method: 'OPTIONS',
    headers: {
      'Origin': 'null',
      'Access-Control-Request-Method': 'GET'
    }
  });
  
  const allowOrigin = res.headers.get('access-control-allow-origin');
  assert.notEqual(allowOrigin, 'null');
});
