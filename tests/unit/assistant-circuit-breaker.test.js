import test from 'node:test';
import assert from 'node:assert/strict';

import { CircuitBreaker, tierKeyFor } from '../../src/assistant-agent/circuit-breaker.js';

function clock(start = 1_700_000_000_000) {
    let t = start;
    return {
        now: () => t,
        advance: (ms) => { t += ms; }
    };
}

test('CircuitBreaker stays healthy below threshold and trips at threshold', () => {
    const c = clock();
    const breaker = new CircuitBreaker({ failureThreshold: 3, probeIntervalMs: 60_000, now: c.now });

    assert.equal(breaker.recordFailure('k1'), 'healthy');
    assert.equal(breaker.recordFailure('k1'), 'healthy');
    assert.equal(breaker.recordFailure('k1'), 'tripped');
    assert.equal(breaker.shouldSkip('k1'), true);
    assert.equal(breaker.isProbeReady('k1'), false);
});

test('CircuitBreaker recordSuccess clears failure counter and state', () => {
    const c = clock();
    const breaker = new CircuitBreaker({ failureThreshold: 3, probeIntervalMs: 60_000, now: c.now });

    breaker.recordFailure('k1');
    breaker.recordFailure('k1');
    breaker.recordSuccess('k1');
    assert.equal(breaker.recordFailure('k1'), 'healthy');
    assert.equal(breaker.recordFailure('k1'), 'healthy');
    assert.equal(breaker.recordFailure('k1'), 'tripped');
});

test('CircuitBreaker first probe fires after probeIntervalMs, not immediately', () => {
    const c = clock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, probeIntervalMs: 5_000, now: c.now });

    breaker.recordFailure('k1');
    breaker.recordFailure('k1');
    assert.equal(breaker.shouldSkip('k1'), true);
    assert.equal(breaker.isProbeReady('k1'), false);

    c.advance(4_999);
    assert.equal(breaker.isProbeReady('k1'), false);
    assert.equal(breaker.shouldSkip('k1'), true);

    c.advance(1);
    assert.equal(breaker.isProbeReady('k1'), true);
    assert.equal(breaker.shouldSkip('k1'), false);
});

test('CircuitBreaker probe success returns to healthy and resets counter', () => {
    const c = clock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, probeIntervalMs: 5_000, now: c.now });

    breaker.recordFailure('k1');
    breaker.recordFailure('k1');
    c.advance(5_000);
    breaker.recordSuccess('k1');

    assert.equal(breaker.getState('k1').state, 'healthy');
    assert.equal(breaker.getState('k1').consecutiveFailures, 0);
});

test('CircuitBreaker rescheduleProbe pushes nextProbeAt out by probeIntervalMs', () => {
    const c = clock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, probeIntervalMs: 5_000, now: c.now });

    breaker.recordFailure('k1');
    breaker.recordFailure('k1');
    c.advance(5_000);
    assert.equal(breaker.isProbeReady('k1'), true);

    breaker.rescheduleProbe('k1');
    assert.equal(breaker.isProbeReady('k1'), false);

    c.advance(5_000);
    assert.equal(breaker.isProbeReady('k1'), true);
});

test('CircuitBreaker reset clears tier state, allowing immediate use', () => {
    const c = clock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, probeIntervalMs: 5_000, now: c.now });

    breaker.recordFailure('k1');
    breaker.recordFailure('k1');
    assert.equal(breaker.shouldSkip('k1'), true);

    breaker.reset('k1');
    assert.equal(breaker.shouldSkip('k1'), false);
    assert.equal(breaker.getState('k1').state, 'healthy');
    assert.equal(breaker.getState('k1').consecutiveFailures, 0);
});

test('CircuitBreaker pruneTo drops state for keys not in the keep set', () => {
    const c = clock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, probeIntervalMs: 5_000, now: c.now });

    breaker.recordFailure('k1');
    breaker.recordFailure('k1');
    breaker.recordFailure('k2');
    breaker.recordFailure('k2');

    breaker.pruneTo(['k1']);
    assert.deepEqual(Object.keys(breaker.snapshot()), ['k1']);
});

test('CircuitBreaker updateThresholds adjusts behavior for subsequent failures only', () => {
    const c = clock();
    const breaker = new CircuitBreaker({ failureThreshold: 5, probeIntervalMs: 60_000, now: c.now });

    breaker.recordFailure('k1');
    breaker.recordFailure('k1');
    assert.equal(breaker.getState('k1').state, 'healthy');

    breaker.updateThresholds({ failureThreshold: 3 });
    assert.equal(breaker.recordFailure('k1'), 'tripped');
});

test('CircuitBreaker independent tiers do not affect each other', () => {
    const c = clock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, probeIntervalMs: 5_000, now: c.now });

    breaker.recordFailure('primary');
    breaker.recordFailure('primary');
    assert.equal(breaker.shouldSkip('primary'), true);
    assert.equal(breaker.shouldSkip('fallback-1'), false);

    breaker.recordSuccess('fallback-1');
    assert.equal(breaker.getState('primary').state, 'tripped');
    assert.equal(breaker.getState('fallback-1').state, 'healthy');
});

test('tierKeyFor produces stable composite key from descriptor', () => {
    assert.equal(tierKeyFor({ type: 'api-key', id: 'key_xyz' }), 'api-key::key_xyz');
    assert.equal(tierKeyFor({ type: 'claude-account', id: 'me@example.com' }), 'claude-account::me@example.com');
    assert.equal(tierKeyFor({}), '');
    assert.equal(tierKeyFor({ type: 'api-key' }), '');
    assert.equal(tierKeyFor({ id: 'key_xyz' }), '');
});
