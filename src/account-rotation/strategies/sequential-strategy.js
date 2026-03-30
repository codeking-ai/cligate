import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';

export class SequentialStrategy extends BaseStrategy {
    constructor(config) {
        super(config, 'sequential');
        this.nextIndex = 0;
    }

    selectAccount(accounts, modelId) {
        if (!accounts || accounts.length === 0) {
            return { account: null, index: 0, waitMs: 0 };
        }

        if (this.nextIndex >= accounts.length) {
            this.nextIndex = 0;
        }

        for (let i = 0; i < accounts.length; i++) {
            const checkIndex = (this.nextIndex + i) % accounts.length;
            const account = accounts[checkIndex];

            if (this.isAccountUsable(account, modelId)) {
                account.lastUsed = Date.now();
                this.nextIndex = (checkIndex + 1) % accounts.length;
                logger.debug(`SequentialStrategy: Using account at index ${checkIndex}`);
                return { account, index: checkIndex, waitMs: 0 };
            }
        }

        return { account: null, index: this.nextIndex, waitMs: 0 };
    }

    resetCursor() {
        this.nextIndex = 0;
    }
}
