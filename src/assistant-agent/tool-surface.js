import { AssistantToolsExecutor } from '../assistant-tools/index.js';

export class CombinedAssistantToolRegistry {
  constructor({
    primaryRegistry,
    secondaryRegistry = null
  } = {}) {
    this.primaryRegistry = primaryRegistry;
    this.secondaryRegistry = secondaryRegistry;
  }

  get(name) {
    return this.primaryRegistry?.get?.(name)
      || this.secondaryRegistry?.get?.(name)
      || null;
  }

  list() {
    const combined = [];
    const seen = new Set();
    for (const registry of [this.primaryRegistry, this.secondaryRegistry]) {
      const entries = registry?.list?.() || [];
      for (const tool of entries) {
        if (!tool?.name || seen.has(tool.name)) continue;
        seen.add(tool.name);
        combined.push(tool);
      }
    }
    return combined;
  }
}

export class CombinedAssistantToolExecutor {
  constructor({
    primaryRegistry,
    primaryExecutor,
    secondaryRegistry = null,
    secondaryExecutor = null
  } = {}) {
    this.primaryRegistry = primaryRegistry;
    this.primaryExecutor = primaryExecutor;
    this.secondaryRegistry = secondaryRegistry;
    this.secondaryExecutor = secondaryExecutor;
    this.policyService = primaryExecutor?.policyService || secondaryExecutor?.policyService || null;
  }

  async executeToolCall(call = {}, context = {}) {
    if (this.primaryRegistry?.get?.(call.toolName)) {
      return this.primaryExecutor.executeToolCall(call, context);
    }

    if (this.secondaryRegistry?.get?.(call.toolName)) {
      const rawResult = await this.secondaryExecutor.executeToolCall(call, context);
      return {
        toolName: String(call.toolName || ''),
        input: call.input || {},
        ...rawResult
      };
    }

    return this.primaryExecutor.executeToolCall(call, context);
  }
}

export function createOptionalAssistantExecutionSurface({
  primaryRegistry,
  primaryExecutor,
  secondaryRegistry = null,
  secondaryExecutor = null
} = {}) {
  if (!secondaryRegistry || !secondaryExecutor) {
    return {
      toolRegistry: primaryRegistry,
      toolExecutor: primaryExecutor
    };
  }

  const resolvedSecondaryExecutor = secondaryExecutor instanceof AssistantToolsExecutor
    ? secondaryExecutor
    : secondaryExecutor;

  return {
    toolRegistry: new CombinedAssistantToolRegistry({
      primaryRegistry,
      secondaryRegistry
    }),
    toolExecutor: new CombinedAssistantToolExecutor({
      primaryRegistry,
      primaryExecutor,
      secondaryRegistry,
      secondaryExecutor: resolvedSecondaryExecutor
    })
  };
}

export default {
  CombinedAssistantToolRegistry,
  CombinedAssistantToolExecutor,
  createOptionalAssistantExecutionSurface
};
