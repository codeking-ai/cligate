import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';
import { CHANNEL_CONVERSATION_MODE, createChannelConversation } from './models.js';

function nowIso() {
  return new Date().toISOString();
}

export class AgentChannelConversationStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'agent-channels');
    this.file = join(this.rootDir, 'conversations.json');
    this.ensureDirs();
    this.conversations = this._load();
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
      return Array.isArray(parsed?.conversations) ? parsed.conversations : [];
    } catch {
      return [];
    }
  }

  _save() {
    this.ensureDirs();
    writeFileSync(
      this.file,
      JSON.stringify({ conversations: this.conversations }, null, 2),
      { mode: 0o600 }
    );
  }

  list({ limit = 100 } = {}) {
    return [...this.conversations]
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, Math.max(1, limit));
  }

  get(conversationId) {
    return this.conversations.find((entry) => entry.id === conversationId) || null;
  }

  save(conversation) {
    const index = this.conversations.findIndex((entry) => entry.id === conversation.id);
    const updated = {
      ...conversation,
      updatedAt: nowIso()
    };

    if (index >= 0) {
      this.conversations[index] = updated;
    } else {
      this.conversations.push(updated);
    }

    this._save();
    return updated;
  }

  patch(conversationId, patch = {}) {
    const current = this.get(conversationId);
    if (!current) return null;
    return this.save({
      ...current,
      ...patch
    });
  }

  findByExternal(channel, accountId, externalConversationId, externalUserId, externalThreadId = '') {
    return this.conversations.find((entry) => (
      entry.channel === String(channel || '')
      && entry.accountId === String(accountId || 'default')
      && entry.externalConversationId === String(externalConversationId || '')
      && entry.externalUserId === String(externalUserId || '')
      && String(entry.externalThreadId || '') === String(externalThreadId || '')
    )) || null;
  }

  findOrCreateByExternal({
    channel,
    accountId = 'default',
    externalConversationId,
    externalUserId,
    externalThreadId = '',
    title = '',
    metadata = {}
  } = {}) {
    const existing = this.findByExternal(
      channel,
      accountId,
      externalConversationId,
      externalUserId,
      externalThreadId
    );
    if (existing) {
      return this.patch(existing.id, {
        metadata: {
          ...(existing.metadata || {}),
          ...(metadata || {})
        },
        title: title || existing.title
      });
    }

    return this.save(createChannelConversation({
      channel,
      accountId,
      externalConversationId,
      externalUserId,
      externalThreadId,
      title,
      metadata
    }));
  }

  listByRuntimeSessionId(sessionId) {
    return this.conversations.filter((entry) => entry.activeRuntimeSessionId === sessionId);
  }

  bindRuntimeSession(conversationId, sessionId, patch = {}) {
    return this.patch(conversationId, {
      activeRuntimeSessionId: sessionId,
      ...patch
    });
  }

  clearActiveRuntimeSession(conversationId) {
    return this.patch(conversationId, {
      mode: CHANNEL_CONVERSATION_MODE.ASSISTANT,
      activeRuntimeSessionId: null,
      lastPendingApprovalId: null,
      lastPendingQuestionId: null
    });
  }
}

export const agentChannelConversationStore = new AgentChannelConversationStore();

export default agentChannelConversationStore;
