import { BaseStrategy } from './base-strategy.js';
import { logger } from '../../utils/logger.js';

export class RandomStrategy extends BaseStrategy {
    constructor(config) {
        super(config, 'random');
    }

    selectAccount(accounts, modelId) {
        if (!accounts || accounts.length === 0) {
            return { account: null, index: 0, waitMs: 0 };
        }

        const usable = this.getUsableAccounts(accounts, modelId);
        if (usable.length === 0) {
            return { account: null, index: 0, waitMs: 0 };
        }

        const picked = usable[Math.floor(Math.random() * usable.length)];
        picked.account.lastUsed = Date.now();
        logger.debug(`RandomStrategy: Using account at index ${picked.index}`);
        return { account: picked.account, index: picked.index, waitMs: 0 };
    }
}
