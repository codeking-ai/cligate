import {
    markRateLimited,
    markInvalid,
    clearInvalid,
    isAllRateLimited,
    getMinWaitTimeMs,
    clearExpiredLimits
} from './rate-limits.js';

import { createStrategy, getStrategyLabel, STRATEGIES } from './strategies/index.js';

export class AccountRotator {
    constructor(accountManager, strategyName = 'sequential') {
        this.accountManager = accountManager;
        this.strategy = createStrategy(strategyName);
    }

    selectAccount(modelId, options = {}) {
        const { accounts } = this.accountManager.listAccounts();
        return this.strategy.selectAccount(accounts, modelId, options);
    }

    markRateLimited(email, resetMs, modelId) {
        const { accounts } = this.accountManager.listAccounts();
        markRateLimited(accounts, email, resetMs, modelId);
        this.accountManager.save();
    }

    markInvalid(email, reason) {
        const { accounts } = this.accountManager.listAccounts();
        markInvalid(accounts, email, reason);
        this.accountManager.save();
    }

    clearInvalid(email) {
        const { accounts } = this.accountManager.listAccounts();
        clearInvalid(accounts, email);
        this.accountManager.save();
    }

    isAllRateLimited(modelId) {
        const { accounts } = this.accountManager.listAccounts();
        return isAllRateLimited(accounts, modelId);
    }

    getMinWaitTimeMs(modelId) {
        const { accounts } = this.accountManager.listAccounts();
        return getMinWaitTimeMs(accounts, modelId);
    }

    notifySuccess(account, modelId) {
        if (this.strategy.notifySuccess) {
            this.strategy.notifySuccess(account, modelId);
        }
    }

    notifyRateLimit(account, modelId) {
        if (this.strategy.notifyRateLimit) {
            this.strategy.notifyRateLimit(account, modelId);
        }
    }

    notifyFailure(account, modelId) {
        if (this.strategy.notifyFailure) {
            this.strategy.notifyFailure(account, modelId);
        }
    }

    clearExpiredLimits() {
        const { accounts } = this.accountManager.listAccounts();
        clearExpiredLimits(accounts);
        this.accountManager.save();
    }

    getStrategyName() {
        return this.strategy.name;
    }

    getStrategyLabel() {
        return getStrategyLabel(this.strategy.name);
    }
}

export {
    createStrategy,
    STRATEGIES,
    markRateLimited,
    markInvalid,
    clearInvalid,
    isAllRateLimited,
    getMinWaitTimeMs,
    clearExpiredLimits
};
