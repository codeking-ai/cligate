import { BaseStrategy } from './base-strategy.js';
import { RandomStrategy } from './random-strategy.js';
import { SequentialStrategy } from './sequential-strategy.js';

export { BaseStrategy, RandomStrategy, SequentialStrategy };

export const DEFAULT_STRATEGY = 'sequential';

export const STRATEGIES = {
  RANDOM: 'random',
  SEQUENTIAL: 'sequential',
};

const legacyStrategyMap = {
  sticky: STRATEGIES.SEQUENTIAL,
  'round-robin': STRATEGIES.SEQUENTIAL,
};

const strategyMap = {
  [STRATEGIES.RANDOM]: RandomStrategy,
  [STRATEGIES.SEQUENTIAL]: SequentialStrategy,
};

const strategyLabels = {
  [STRATEGIES.RANDOM]: 'Random',
  [STRATEGIES.SEQUENTIAL]: 'Sequential',
};

export function normalizeStrategyName(name) {
  if (typeof name !== 'string' || !name) {
    return DEFAULT_STRATEGY;
  }

  return strategyMap[name] ? name : (legacyStrategyMap[name] || DEFAULT_STRATEGY);
}

export function isSupportedStrategyName(name) {
  return Boolean(strategyMap[name] || legacyStrategyMap[name]);
}

export function createStrategy(name, config) {
  const normalized = normalizeStrategyName(name);
  const StrategyClass = strategyMap[normalized];
  return new StrategyClass(config);
}

export function getStrategyLabel(name) {
  const normalized = normalizeStrategyName(name);
  return strategyLabels[normalized] || strategyLabels[DEFAULT_STRATEGY];
}
