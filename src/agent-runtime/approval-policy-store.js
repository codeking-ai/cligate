import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';
import { approvalPolicyMatchesRequest } from './approval-policy.js';

function nowIso() {
  return new Date().toISOString();
}

export class AgentRuntimeApprovalPolicyStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'agent-runtime');
    this.file = join(this.rootDir, 'approval-policies.json');
    this.ensureDirs();
    this.records = this._load();
  }

  ensureDirs() {
    if (!existsSync(this.rootDir)) {
      mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    }
  }

  _load() {
    this.ensureDirs();
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed?.policies) ? parsed.policies : [];
    } catch {
      return [];
    }
  }

  _save() {
    this.ensureDirs();
    writeFileSync(
      this.file,
      JSON.stringify({ policies: this.records }, null, 2),
      { mode: 0o600 }
    );
  }

  createPolicy({ scope = 'session', scopeRef, provider, toolName, decision = 'allow', pathPatterns = [], commandPrefixes = [], metadata = {} } = {}) {
    if (!scopeRef) {
      throw new Error('scopeRef is required');
    }

    const policy = {
      id: crypto.randomUUID(),
      scope: String(scope || 'session'),
      scopeRef: String(scopeRef),
      provider: String(provider || ''),
      toolName: String(toolName || ''),
      decision: String(decision || 'allow'),
      pathPatterns: Array.isArray(pathPatterns) ? pathPatterns.filter(Boolean) : [],
      commandPrefixes: Array.isArray(commandPrefixes) ? commandPrefixes.filter(Boolean) : [],
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    this.records.push(policy);
    this._save();
    return policy;
  }

  listPolicies({ scope, scopeRef } = {}) {
    return this.records.filter((entry) => (
      (!scope || entry.scope === scope)
      && (!scopeRef || entry.scopeRef === scopeRef)
    ));
  }

  findMatchingPolicy({ scope = 'session', scopeRef, provider, rawRequest } = {}) {
    return this.records.find((entry) => (
      entry.scope === scope
      && entry.scopeRef === String(scopeRef || '')
      && (!provider || !entry.provider || entry.provider === provider)
      && approvalPolicyMatchesRequest(entry, rawRequest)
    )) || null;
  }

  findFirstMatchingPolicy({ candidates = [], provider, rawRequest } = {}) {
    for (const candidate of candidates) {
      const match = this.findMatchingPolicy({
        scope: candidate?.scope,
        scopeRef: candidate?.scopeRef,
        provider,
        rawRequest
      });
      if (match) {
        return match;
      }
    }
    return null;
  }
}

export const agentRuntimeApprovalPolicyStore = new AgentRuntimeApprovalPolicyStore();

export default agentRuntimeApprovalPolicyStore;
