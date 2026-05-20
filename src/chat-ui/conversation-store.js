import {
  AgentChannelConversationStore,
  agentChannelConversationStore
} from '../agent-channels/conversation-store.js';
import { buildAssistantCoreDeliveryState } from '../agent-channels/conversation-delivery-arbiter.js';
import { CONVERSATION_ASSISTANT_CONTROL_MODE } from '../agent-channels/models.js';

const CHANNEL = 'chat-ui';
const ACCOUNT_ID = 'default';
const EXTERNAL_USER_ID = 'local-user';

// Chat-UI channel parity (2026-05-20):
// Web Chat is a true peer of dingtalk/wechat/feishu — incoming messages should
// enter the Assistant Agent supervisor (see mode-service.maybeHandleMessage +
// assistant-state.getAssistantControlMode). Every chat-ui conversation must
// carry `assistantCore.controlMode = 'assistant'` so the very first message is
// orchestrated by the assistant, not blindly forwarded to the bound CLI.
function seededAssistantCoreMetadata(extraMetadata = {}) {
  const base = extraMetadata && typeof extraMetadata === 'object' ? extraMetadata : {};
  return {
    ...base,
    assistantCore: buildAssistantCoreDeliveryState(
      (base.assistantCore && typeof base.assistantCore === 'object') ? base.assistantCore : {},
      { controlMode: CONVERSATION_ASSISTANT_CONTROL_MODE.ASSISTANT }
    )
  };
}

// Critical (2026-05-20): The previous version exported its own
// `new ChatUiConversationStore()` instance. That meant chat-ui and
// agent-channels (used by message-service / scheduler / delivery-sender) each
// held a SEPARATE in-memory `conversations` array, even though both wrote to
// the same JSON file on disk. After server start, a chat-ui conversation
// created at runtime was visible to chat-ui-route but NOT to message-service,
// so scheduler deliveries hit `conversation_not_found` and silently dropped
// notifications (`delivered: 0 target(s)`).
//
// Fix: attach chat-ui specific helpers to the shared singleton, then re-export
// that same instance. Single source of truth, single .conversations array.
function installChatUiHelpers(store) {
  store.getBySessionId = function (sessionId) {
    return this.findByExternal(
      CHANNEL,
      ACCOUNT_ID,
      String(sessionId || ''),
      EXTERNAL_USER_ID
    );
  };

  store.findOrCreateBySessionId = function (sessionId, metadata = {}) {
    const externalConversationId = String(sessionId || '');
    const existing = this.findByExternal(
      CHANNEL,
      ACCOUNT_ID,
      externalConversationId,
      EXTERNAL_USER_ID
    );

    // For existing conversations preserve the current controlMode — the user
    // may have toggled to direct-runtime via /runtime.
    if (existing) {
      return this.findOrCreateByExternal({
        channel: CHANNEL,
        accountId: ACCOUNT_ID,
        externalConversationId,
        externalUserId: EXTERNAL_USER_ID,
        title: existing.title || `Chat UI / ${String(sessionId || 'session')}`,
        metadata
      });
    }

    // New conversation: seed assistantCore.controlMode='assistant'.
    return this.findOrCreateByExternal({
      channel: CHANNEL,
      accountId: ACCOUNT_ID,
      externalConversationId,
      externalUserId: EXTERNAL_USER_ID,
      title: `Chat UI / ${String(sessionId || 'session')}`,
      metadata: seededAssistantCoreMetadata(metadata)
    });
  };
}

// One-shot migration for the legacy chat-ui rows that pre-date assistant-mode
// seeding. Idempotent — only touches rows that never reached the Assistant
// Agent (assistantSessionId/lastRunId both null) so we don't undo a deliberate
// `/runtime` exit.
function migrateUntouchedChatUiConversationsToAssistant(store) {
  if (!Array.isArray(store.conversations) || store.conversations.length === 0) return;
  let mutated = false;
  for (const conversation of store.conversations) {
    if (conversation?.channel !== CHANNEL) continue;
    const assistantCore = conversation?.metadata?.assistantCore || {};
    const controlMode = String(assistantCore.controlMode || assistantCore.mode || '').trim();
    const everActivated = Boolean(assistantCore.assistantSessionId || assistantCore.lastRunId);
    if (controlMode === CONVERSATION_ASSISTANT_CONTROL_MODE.ASSISTANT) continue;
    if (everActivated) continue;
    conversation.metadata = {
      ...(conversation.metadata || {}),
      assistantCore: buildAssistantCoreDeliveryState(assistantCore, {
        controlMode: CONVERSATION_ASSISTANT_CONTROL_MODE.ASSISTANT
      })
    };
    mutated = true;
  }
  if (mutated) {
    store._save();
  }
}

installChatUiHelpers(agentChannelConversationStore);
migrateUntouchedChatUiConversationsToAssistant(agentChannelConversationStore);

// Class kept for type-import compatibility and for tests that need an
// independent in-memory instance. Inherits all behavior from the parent;
// production callers must use the exported singleton.
export class ChatUiConversationStore extends AgentChannelConversationStore {
  constructor(options = {}) {
    super(options);
    installChatUiHelpers(this);
    migrateUntouchedChatUiConversationsToAssistant(this);
  }
}

export const chatUiConversationStore = agentChannelConversationStore;

export default chatUiConversationStore;
