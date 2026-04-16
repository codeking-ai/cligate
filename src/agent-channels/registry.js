import FeishuChannelProvider from './providers/feishu-provider.js';
import TelegramChannelProvider from './providers/telegram-provider.js';

export class AgentChannelRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(provider) {
    if (!provider?.id) {
      throw new Error('Channel provider id is required');
    }
    this.providers.set(provider.id, provider);
    return provider;
  }

  get(providerId) {
    return this.providers.get(String(providerId || '')) || null;
  }

  list() {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      capabilities: provider.capabilities || {}
    }));
  }
}

export function createDefaultAgentChannelRegistry() {
  const registry = new AgentChannelRegistry();
  registry.register(new TelegramChannelProvider());
  registry.register(new FeishuChannelProvider());
  return registry;
}

export const agentChannelRegistry = createDefaultAgentChannelRegistry();

export default agentChannelRegistry;
