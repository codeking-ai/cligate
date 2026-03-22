/**
 * Base Provider
 * All API providers must implement this interface.
 */

export class BaseProvider {
    constructor(config) {
        this.id = config.id;
        this.name = config.name;
        this.type = config.type; // 'openai', 'anthropic', 'gemini'
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl;
        this.enabled = config.enabled !== false;
        this.addedAt = config.addedAt || new Date().toISOString();
        this.lastUsed = config.lastUsed || null;
        this.totalRequests = config.totalRequests || 0;
        this.totalTokens = config.totalTokens || 0;
        this.totalCost = config.totalCost || 0;
        this.errors = config.errors || 0;
        this.rateLimitedUntil = config.rateLimitedUntil || null;
    }

    get isRateLimited() {
        if (!this.rateLimitedUntil) return false;
        return Date.now() < this.rateLimitedUntil;
    }

    get isAvailable() {
        return this.enabled && !this.isRateLimited;
    }

    get maskedKey() {
        if (!this.apiKey) return '';
        if (this.apiKey.length <= 8) return '****';
        return this.apiKey.slice(0, 4) + '...' + this.apiKey.slice(-4);
    }

    markUsed(tokens, cost) {
        this.lastUsed = new Date().toISOString();
        this.totalRequests++;
        this.totalTokens += tokens || 0;
        this.totalCost += cost || 0;
    }

    markError() {
        this.errors++;
    }

    markRateLimited(durationMs) {
        this.rateLimitedUntil = Date.now() + durationMs;
    }

    clearRateLimit() {
        this.rateLimitedUntil = null;
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            type: this.type,
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
            enabled: this.enabled,
            addedAt: this.addedAt,
            lastUsed: this.lastUsed,
            totalRequests: this.totalRequests,
            totalTokens: this.totalTokens,
            totalCost: this.totalCost,
            errors: this.errors
        };
    }

    toSafeJSON() {
        const json = this.toJSON();
        json.apiKey = this.maskedKey;
        json.isAvailable = this.isAvailable;
        json.isRateLimited = this.isRateLimited;
        return json;
    }
}

export default BaseProvider;
