/**
 * Unit tests for src/account-rotation/strategies/
 * Tests account selection strategies.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createStrategy,
    DEFAULT_STRATEGY,
    normalizeStrategyName
} from '../../src/account-rotation/strategies/index.js';

function createTestAccounts() {
    return [
        { email: 'account1@test.com', modelRateLimits: {} },
        { email: 'account2@test.com', modelRateLimits: {} },
        { email: 'account3@test.com', modelRateLimits: {} }
    ];
}

test('createStrategy: creates sequential strategy by default', () => {
    const strategy = createStrategy();
    assert.ok(strategy !== null);
    assert.equal(strategy.name, 'sequential');
    assert.equal(DEFAULT_STRATEGY, 'sequential');
});

test('createStrategy: creates random strategy', () => {
    const strategy = createStrategy('random');
    assert.ok(strategy !== null);
    assert.equal(strategy.name, 'random');
});

test('createStrategy: creates sequential strategy', () => {
    const strategy = createStrategy('sequential');
    assert.ok(strategy !== null);
    assert.equal(strategy.name, 'sequential');
});

test('createStrategy: maps legacy names to sequential', () => {
    assert.equal(createStrategy('sticky').name, 'sequential');
    assert.equal(createStrategy('round-robin').name, 'sequential');
});

test('createStrategy: falls back to sequential for unknown strategy', () => {
    const strategy = createStrategy('unknown-strategy');
    assert.ok(strategy !== null);
    assert.equal(strategy.name, 'sequential');
});

test('normalizeStrategyName: normalizes legacy names', () => {
    assert.equal(normalizeStrategyName('sticky'), 'sequential');
    assert.equal(normalizeStrategyName('round-robin'), 'sequential');
    assert.equal(normalizeStrategyName('random'), 'random');
    assert.equal(normalizeStrategyName('sequential'), 'sequential');
});

test('Random Strategy: picks a usable account', () => {
    const strategy = createStrategy('random');
    const accounts = createTestAccounts();

    const result = strategy.selectAccount(accounts, 'gpt-5.2');
    assert.ok(['account1@test.com', 'account2@test.com', 'account3@test.com'].includes(result.account.email));
});

test('Random Strategy: skips unusable accounts', () => {
    const strategy = createStrategy('random');
    const accounts = createTestAccounts();
    accounts[0].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() + 60000 };
    accounts[1].isInvalid = true;

    const result = strategy.selectAccount(accounts, 'gpt-5.2');
    assert.equal(result.account.email, 'account3@test.com');
});

test('Random Strategy: returns null when no accounts usable', () => {
    const strategy = createStrategy('random');
    const accounts = createTestAccounts();
    accounts.forEach((account) => { account.isInvalid = true; });

    const result = strategy.selectAccount(accounts, 'gpt-5.2');
    assert.equal(result.account, null);
});

test('Sequential Strategy: rotates through accounts in order', () => {
    const strategy = createStrategy('sequential');
    const accounts = createTestAccounts();

    const result1 = strategy.selectAccount(accounts, 'gpt-5.2');
    assert.equal(result1.account.email, 'account1@test.com');

    const result2 = strategy.selectAccount(accounts, 'gpt-5.2');
    assert.equal(result2.account.email, 'account2@test.com');

    const result3 = strategy.selectAccount(accounts, 'gpt-5.2');
    assert.equal(result3.account.email, 'account3@test.com');
});

test('Sequential Strategy: skips rate-limited accounts', () => {
    const strategy = createStrategy('sequential');
    const accounts = createTestAccounts();
    accounts[0].modelRateLimits['gpt-5.2'] = { isRateLimited: true, resetTime: Date.now() + 60000 };

    const result = strategy.selectAccount(accounts, 'gpt-5.2');
    assert.equal(result.account.email, 'account2@test.com');
});

test('Sequential Strategy: continues from the next usable account', () => {
    const strategy = createStrategy('sequential');
    const accounts = createTestAccounts();
    accounts[0].isInvalid = true;

    const result1 = strategy.selectAccount(accounts, 'gpt-5.2');
    assert.equal(result1.account.email, 'account2@test.com');

    const result2 = strategy.selectAccount(accounts, 'gpt-5.2');
    assert.equal(result2.account.email, 'account3@test.com');
});

test('Sequential Strategy: handles single account', () => {
    const strategy = createStrategy('sequential');
    const accounts = [{ email: 'only@test.com', modelRateLimits: {} }];

    const result = strategy.selectAccount(accounts, 'gpt-5.2');
    assert.equal(result.account.email, 'only@test.com');
});

test('Sequential Strategy: returns null when no accounts usable', () => {
    const strategy = createStrategy('sequential');
    const accounts = createTestAccounts();
    accounts.forEach((account) => { account.isInvalid = true; });

    const result = strategy.selectAccount(accounts, 'gpt-5.2');
    assert.equal(result.account, null);
});

test('isAccountUsable: returns false for null account', () => {
    const strategy = createStrategy('sequential');
    const result = strategy.isAccountUsable(null, 'gpt-5.2');
    assert.equal(result, false);
});

test('isAccountUsable: returns false for invalid account', () => {
    const strategy = createStrategy('sequential');
    const result = strategy.isAccountUsable({ isInvalid: true }, 'gpt-5.2');
    assert.equal(result, false);
});

test('isAccountUsable: returns false for disabled account', () => {
    const strategy = createStrategy('sequential');
    const result = strategy.isAccountUsable({ enabled: false }, 'gpt-5.2');
    assert.equal(result, false);
});

test('isAccountUsable: returns false for rate-limited account', () => {
    const strategy = createStrategy('sequential');
    const account = {
        modelRateLimits: {
            'gpt-5.2': { isRateLimited: true, resetTime: Date.now() + 60000 }
        }
    };
    const result = strategy.isAccountUsable(account, 'gpt-5.2');
    assert.equal(result, false);
});

test('isAccountUsable: returns true for healthy account', () => {
    const strategy = createStrategy('sequential');
    const result = strategy.isAccountUsable({}, 'gpt-5.2');
    assert.equal(result, true);
});

test('isAccountUsable: returns true when rate limit expired', () => {
    const strategy = createStrategy('sequential');
    const account = {
        modelRateLimits: {
            'gpt-5.2': { isRateLimited: true, resetTime: Date.now() - 1000 }
        }
    };
    const result = strategy.isAccountUsable(account, 'gpt-5.2');
    assert.equal(result, true);
});
