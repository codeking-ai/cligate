function normalizeText(value) {
  return String(value || '').trim();
}

export class AssistantToolsRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(definition = {}) {
    const name = normalizeText(definition.name);
    if (!name) {
      throw new Error('tool name is required');
    }
    if (typeof definition.execute !== 'function') {
      throw new Error(`tool ${name} must define execute()`);
    }
    const normalized = {
      visibility: 'direct',
      mutating: false,
      requiresApproval: false,
      parallelSafe: true,
      source: 'hosted',
      ...definition,
      name
    };
    this.tools.set(name, normalized);
    return normalized;
  }

  get(name) {
    return this.tools.get(normalizeText(name)) || null;
  }

  list({ visibility = null } = {}) {
    const entries = [...this.tools.values()];
    if (!visibility) {
      return entries;
    }
    return entries.filter((tool) => tool.visibility === visibility);
  }
}

export default AssistantToolsRegistry;
