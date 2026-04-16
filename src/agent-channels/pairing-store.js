import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';
import { CHANNEL_PAIRING_STATUS, createPairingRecord } from './models.js';

function generatePairingCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

export class AgentChannelPairingStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'agent-channels');
    this.file = join(this.rootDir, 'pairing.json');
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
      return Array.isArray(parsed?.records) ? parsed.records : [];
    } catch {
      return [];
    }
  }

  _save() {
    this.ensureDirs();
    writeFileSync(
      this.file,
      JSON.stringify({ records: this.records }, null, 2),
      { mode: 0o600 }
    );
  }

  get(channel, accountId, externalUserId, externalConversationId) {
    return this.records.find((entry) => (
      entry.channel === String(channel || '')
      && entry.accountId === String(accountId || 'default')
      && entry.externalUserId === String(externalUserId || '')
      && entry.externalConversationId === String(externalConversationId || '')
    )) || null;
  }

  isApproved(channel, accountId, externalUserId, externalConversationId) {
    return this.get(channel, accountId, externalUserId, externalConversationId)?.status === CHANNEL_PAIRING_STATUS.APPROVED;
  }

  createRequest({ channel, accountId = 'default', externalUserId, externalConversationId } = {}) {
    const existing = this.get(channel, accountId, externalUserId, externalConversationId);
    if (existing) {
      return existing;
    }

    const record = createPairingRecord({
      channel,
      accountId,
      externalUserId,
      externalConversationId,
      code: generatePairingCode()
    });
    this.records.push(record);
    this._save();
    return record;
  }

  approve({ channel, accountId = 'default', externalUserId, externalConversationId, approvedBy = 'system' } = {}) {
    const record = this.get(channel, accountId, externalUserId, externalConversationId);
    if (!record) return null;
    record.status = CHANNEL_PAIRING_STATUS.APPROVED;
    record.approvedAt = new Date().toISOString();
    record.approvedBy = String(approvedBy || 'system');
    this._save();
    return record;
  }

  deny({ channel, accountId = 'default', externalUserId, externalConversationId, approvedBy = 'system' } = {}) {
    const record = this.get(channel, accountId, externalUserId, externalConversationId);
    if (!record) return null;
    record.status = CHANNEL_PAIRING_STATUS.DENIED;
    record.approvedAt = new Date().toISOString();
    record.approvedBy = String(approvedBy || 'system');
    this._save();
    return record;
  }
}

export const agentChannelPairingStore = new AgentChannelPairingStore();

export default agentChannelPairingStore;
