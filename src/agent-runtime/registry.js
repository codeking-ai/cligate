import CodexProvider from './providers/codex-provider.js';
import ClaudeCodeProvider from './providers/claude-code-provider.js';

export class AgentRuntimeRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(provider) {
    if (!provider?.id) {
      throw new Error('Provider id is required');
    }
    this.providers.set(provider.id, provider);
    return provider;
  }

  get(providerId) {
    return this.providers.get(providerId) || null;
  }

  list() {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      capabilities: provider.capabilities || {}
    }));
  }
}

export function createDefaultAgentRuntimeRegistry() {
  const registry = new AgentRuntimeRegistry();
  registry.register(new CodexProvider());
  registry.register(new ClaudeCodeProvider());
  return registry;
}

export default AgentRuntimeRegistry;

