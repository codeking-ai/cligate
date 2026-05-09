import './test-env.js';
/**
 * Account Rotation Tests
 */

import * as assert from 'node:assert';

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
} from '../src/account-rotation/rate-limits.js';

console.log('Running account-rotation tests...\n');

// Test setup
let accounts;
function setup() {
    accounts = [
        { email: 'account1@test.com', modelRateLimits: {} },
        { email: 'account2@test.com', modelRateLimits: {} },
        { email: 'account3@test.com', modelRateLimits: {} }
    ];
}

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        setup();
        fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (e) {
        console.log(`✗ ${name}`);
        console.log(`  Error: ${e.message}`);
        failed++;
    }
}

// ===== TESTS =====

test('isAllRateLimited: should return false when no accounts rate-limited', () => {
    const result = isAllRateLimited(accounts, 'gpt-5.2');
    assert.strictEqual(result, false);
});

test('isAllRateLimited: should return true when all accounts rate-limited', () => {
    accounts[0].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() + 60000 };
    accounts[1].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() + 60000 };
    accounts[2].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() + 60000 };
    
    const result = isAllRateLimited(accounts, 'gpt-5.2');
    assert.strictEqual(result, true);
});

test('isAllRateLimited: should return true for empty accounts', () => {
    const result = isAllRateLimited([], 'gpt-5.2');
    assert.strictEqual(result, true);
});

test('isAllRateLimited: should return false when rate limit expired', () => {
    accounts[0].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() - 1000 };
    
    const result = isAllRateLimited(accounts, 'gpt-5.2');
    assert.strictEqual(result, false);
});

test('getAvailableAccounts: should return all accounts when none rate-limited', () => {
    const result = getAvailableAccounts(accounts, 'gpt-5.2');
    assert.strictEqual(result.length, 3);
});

test('getAvailableAccounts: should exclude rate-limited accounts', () => {
    accounts[0].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() + 60000 };
    
    const result = getAvailableAccounts(accounts, 'gpt-5.2');
    assert.strictEqual(result.length, 2);
    assert.ok(!result.find(a => a.email === 'account1@test.com'));
});

test('getAvailableAccounts: should exclude invalid accounts', () => {
    accounts[0].isInvalid = true;
    
    const result = getAvailableAccounts(accounts, 'gpt-5.2');
    assert.strictEqual(result.length, 2);
});

test('getAvailableAccounts: should exclude accounts cooling down', () => {
    accounts[0].cooldownUntil = Date.now() + 60000;
    
    const result = getAvailableAccounts(accounts, 'gpt-5.2');
    assert.strictEqual(result.length, 2);
});

test('markRateLimited: should mark account as rate-limited', () => {
    markRateLimited(accounts, 'account1@test.com', 60000, 'gpt-5.2');
    
    const limit = accounts[0].modelRateLimits['gpt-5.2'];
    assert.strictEqual(limit.isRateLimited, true);
    assert.ok(limit.resetTime > Date.now());
});

test('markInvalid: should mark account as invalid', () => {
    markInvalid(accounts, 'account1@test.com', 'Token expired');
    
    assert.strictEqual(accounts[0].isInvalid, true);
    assert.strictEqual(accounts[0].invalidReason, 'Token expired');
});

test('clearInvalid: should clear invalid status', () => {
    accounts[0].isInvalid = true;
    accounts[0].invalidReason = 'Token expired';
    
    clearInvalid(accounts, 'account1@test.com');
    
    assert.strictEqual(accounts[0].isInvalid, false);
    assert.strictEqual(accounts[0].invalidReason, null);
});

test('getMinWaitTimeMs: should return 0 when accounts available', () => {
    const result = getMinWaitTimeMs(accounts, 'gpt-5.2');
    assert.strictEqual(result, 0);
});

test('getMinWaitTimeMs: should return minimum wait time when all rate-limited', () => {
    accounts[0].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() + 30000 };
    accounts[1].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() + 60000 };
    accounts[2].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() + 120000 };
    
    const result = getMinWaitTimeMs(accounts, 'gpt-5.2');
    assert.ok(result > 25000 && result < 35000);
});

test('clearExpiredLimits: should clear expired rate limits', () => {
    accounts[0].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() - 1000 };
    
    const cleared = clearExpiredLimits(accounts);
    
    assert.strictEqual(cleared, 1);
    assert.strictEqual(accounts[0].modelRateLimits['gpt-5.2'].isRateLimited, false);
});

test('incrementConsecutiveFailures: should increment failure count', () => {
    const count = incrementConsecutiveFailures(accounts, 'account1@test.com');
    assert.strictEqual(count, 1);
});

test('resetConsecutiveFailures: should reset failure count', () => {
    accounts[0].consecutiveFailures = 5;
    resetConsecutiveFailures(accounts, 'account1@test.com');
    assert.strictEqual(accounts[0].consecutiveFailures, 0);
});

test('getConsecutiveFailures: should get failure count', () => {
    accounts[0].consecutiveFailures = 3;
    const count = getConsecutiveFailures(accounts, 'account1@test.com');
    assert.strictEqual(count, 3);
});

test('markAccountCoolingDown: should mark account cooling down', () => {
    markAccountCoolingDown(accounts, 'account1@test.com', 60000, CooldownReason.RATE_LIMIT);
    
    assert.ok(accounts[0].cooldownUntil > Date.now());
    assert.strictEqual(accounts[0].cooldownReason, CooldownReason.RATE_LIMIT);
});

test('isAccountCoolingDown: should check if account is cooling down', () => {
    accounts[0].cooldownUntil = Date.now() + 60000;
    
    assert.strictEqual(isAccountCoolingDown(accounts[0]), true);
});

test('getCooldownRemaining: should return remaining cooldown time', () => {
    accounts[0].cooldownUntil = Date.now() + 30000;
    
    const remaining = getCooldownRemaining(accounts[0]);
    assert.ok(remaining > 25000 && remaining < 35000);
});

test('clearAccountCooldown: should clear cooldown', () => {
    accounts[0].cooldownUntil = Date.now() + 60000;
    accounts[0].cooldownReason = CooldownReason.RATE_LIMIT;
    
    clearAccountCooldown(accounts[0]);
    
    assert.strictEqual(accounts[0].cooldownUntil, null);
    assert.strictEqual(accounts[0].cooldownReason, null);
});

// ===== SUMMARY =====
console.log(`\n===================`);
console.log(`Tests: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`===================\n`);

process.exit(failed > 0 ? 1 : 0);
