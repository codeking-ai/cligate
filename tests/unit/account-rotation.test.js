import '../test-env.js';
/**
 * Unit tests for src/account-rotation/rate-limits.js
 * Tests rate limit tracking and account state management.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isAllRateLimited,
    getAvailableAccounts,
    clearExpiredLimits,
    markRateLimited,
    markInvalid,
    clearInvalid,
    getMinWaitTimeMs,
    isAccountCoolingDown,
    markAccountCoolingDown,
    clearAccountCooldown,
    getCooldownRemaining,
    getConsecutiveFailures,
    resetConsecutiveFailures,
    incrementConsecutiveFailures,
    CooldownReason
} from '../../src/account-rotation/rate-limits.js';

function createTestAccounts() {
    return [
        { email: 'account1@test.com', modelRateLimits: {} },
        { email: 'account2@test.com', modelRateLimits: {} },
        { email: 'account3@test.com', modelRateLimits: {} }
    ];
}

// ─── isAllRateLimited ─────────────────────────────────────────────────────────────

test('isAllRateLimited: returns false when no accounts rate-limited', () => {
    const accounts = createTestAccounts();
    const result = isAllRateLimited(accounts, 'gpt-5.2');
    assert.equal(result, false);
});

test('isAllRateLimited: returns true when all accounts rate-limited', () => {
    const accounts = createTestAccounts();
    accounts[0].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() + 60000 };
    accounts[1].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() + 60000 };
    accounts[2].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() + 60000 };
    
    const result = isAllRateLimited(accounts, 'gpt-5.2');
    assert.equal(result, true);
});

test('isAllRateLimited: returns true for empty accounts array', () => {
    const result = isAllRateLimited([], 'gpt-5.2');
    assert.equal(result, true);
});

test('isAllRateLimited: returns false when rate limit expired', () => {
    const accounts = createTestAccounts();
    accounts[0].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() - 1000 };
    
    const result = isAllRateLimited(accounts, 'gpt-5.2');
    assert.equal(result, false);
});

// ─── getAvailableAccounts ─────────────────────────────────────────────────────────

test('getAvailableAccounts: returns all accounts when none rate-limited', () => {
    const accounts = createTestAccounts();
    const result = getAvailableAccounts(accounts, 'gpt-5.2');
    assert.equal(result.length, 3);
});

test('getAvailableAccounts: excludes rate-limited accounts', () => {
    const accounts = createTestAccounts();
    accounts[0].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() + 60000 };
    
    const result = getAvailableAccounts(accounts, 'gpt-5.2');
    assert.equal(result.length, 2);
    assert.ok(!result.find(a => a.email === 'account1@test.com'));
});

test('getAvailableAccounts: excludes invalid accounts', () => {
    const accounts = createTestAccounts();
    accounts[0].isInvalid = true;
    
    const result = getAvailableAccounts(accounts, 'gpt-5.2');
    assert.equal(result.length, 2);
});

test('getAvailableAccounts: excludes accounts cooling down', () => {
    const accounts = createTestAccounts();
    accounts[0].cooldownUntil = Date.now() + 60000;
    
    const result = getAvailableAccounts(accounts, 'gpt-5.2');
    assert.equal(result.length, 2);
});

// ─── markRateLimited ────────────────────────────────────────────────────────────

test('markRateLimited: marks account as rate-limited', () => {
    const accounts = createTestAccounts();
    markRateLimited(accounts, 'account1@test.com', 60000, 'gpt-5.2');
    
    const limit = accounts[0].modelRateLimits['gpt-5.2'];
    assert.equal(limit.isRateLimited, true);
    assert.ok(limit.resetTime > Date.now());
});

test('markRateLimited: stores actual reset time', () => {
    const accounts = createTestAccounts();
    markRateLimited(accounts, 'account1@test.com', 30000, 'gpt-5.2');
    
    const limit = accounts[0].modelRateLimits['gpt-5.2'];
    assert.equal(limit.actualResetMs, 30000);
});

// ─── markInvalid / clearInvalid ─────────────────────────────────────────────────

test('markInvalid: marks account as invalid', () => {
    const accounts = createTestAccounts();
    markInvalid(accounts, 'account1@test.com', 'Token expired');
    
    assert.equal(accounts[0].isInvalid, true);
    assert.equal(accounts[0].invalidReason, 'Token expired');
});

test('clearInvalid: clears invalid status', () => {
    const accounts = createTestAccounts();
    accounts[0].isInvalid = true;
    accounts[0].invalidReason = 'Token expired';
    
    clearInvalid(accounts, 'account1@test.com');
    
    assert.equal(accounts[0].isInvalid, false);
    assert.equal(accounts[0].invalidReason, null);
});

// ─── getMinWaitTimeMs ───────────────────────────────────────────────────────────

test('getMinWaitTimeMs: returns 0 when accounts available', () => {
    const accounts = createTestAccounts();
    const result = getMinWaitTimeMs(accounts, 'gpt-5.2');
    assert.equal(result, 0);
});

test('getMinWaitTimeMs: returns minimum wait time when all rate-limited', () => {
    const accounts = createTestAccounts();
    accounts[0].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() + 30000 };
    accounts[1].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() + 60000 };
    accounts[2].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() + 120000 };
    
    const result = getMinWaitTimeMs(accounts, 'gpt-5.2');
    assert.ok(result > 25000 && result < 35000);
});

// ─── clearExpiredLimits ─────────────────────────────────────────────────────────

test('clearExpiredLimits: clears expired rate limits', () => {
    const accounts = createTestAccounts();
    accounts[0].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() - 1000 };
    
    const cleared = clearExpiredLimits(accounts);
    
    assert.equal(cleared, 1);
    assert.equal(accounts[0].modelRateLimits['gpt-5.2'].isRateLimited, false);
});

// ─── consecutiveFailures ────────────────────────────────────────────────────────

test('incrementConsecutiveFailures: increments failure count', () => {
    const accounts = createTestAccounts();
    const count = incrementConsecutiveFailures(accounts, 'account1@test.com');
    assert.equal(count, 1);
});

test('resetConsecutiveFailures: resets failure count', () => {
    const accounts = createTestAccounts();
    accounts[0].consecutiveFailures = 5;
    resetConsecutiveFailures(accounts, 'account1@test.com');
    assert.equal(accounts[0].consecutiveFailures, 0);
});

test('getConsecutiveFailures: gets failure count', () => {
    const accounts = createTestAccounts();
    accounts[0].consecutiveFailures = 3;
    const count = getConsecutiveFailures(accounts, 'account1@test.com');
    assert.equal(count, 3);
});

// ─── cooldown ───────────────────────────────────────────────────────────────────

test('markAccountCoolingDown: marks account cooling down', () => {
    const accounts = createTestAccounts();
    markAccountCoolingDown(accounts, 'account1@test.com', 60000, CooldownReason.RATE_LIMIT);
    
    assert.ok(accounts[0].cooldownUntil > Date.now());
    assert.equal(accounts[0].cooldownReason, CooldownReason.RATE_LIMIT);
});

test('isAccountCoolingDown: returns true when cooling down', () => {
    const accounts = createTestAccounts();
    accounts[0].cooldownUntil = Date.now() + 60000;
    
    assert.equal(isAccountCoolingDown(accounts[0]), true);
});

test('isAccountCoolingDown: returns false when not cooling down', () => {
    const accounts = createTestAccounts();
    assert.equal(isAccountCoolingDown(accounts[0]), false);
});

test('getCooldownRemaining: returns remaining cooldown time', () => {
    const accounts = createTestAccounts();
    accounts[0].cooldownUntil = Date.now() + 30000;
    
    const remaining = getCooldownRemaining(accounts[0]);
    assert.ok(remaining > 25000 && remaining < 35000);
});

test('clearAccountCooldown: clears cooldown', () => {
    const accounts = createTestAccounts();
    accounts[0].cooldownUntil = Date.now() + 60000;
    accounts[0].cooldownReason = CooldownReason.RATE_LIMIT;
    
    clearAccountCooldown(accounts[0]);
    
    assert.equal(accounts[0].cooldownUntil, null);
    assert.equal(accounts[0].cooldownReason, null);
});
