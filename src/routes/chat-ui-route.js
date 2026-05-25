import { listAccounts } from '../account-manager.js';
import {
  loadAccounts as loadClaudeAccounts,
  refreshAccountToken as refreshClaudeAccountToken,
  getAccount as getClaudeAccount
} from '../claude-account-manager.js';
import {
  listAccounts as listAntigravityAccounts,
  getAccount as getAntigravityAccount,
  refreshAccountToken as refreshAntigravityAccountToken,
  ensureAccountProjectId as ensureAntigravityAccountProjectId
} from '../antigravity-account-manager.js';
import { sendAntigravityMessage, toPublicAntigravityModel } from '../antigravity-api.js';
import { recordClaudeRuntimeObservation } from '../claude-usage.js';
import { getCredentialsForAccount } from '../middleware/credentials.js';
import { sendMessage, sendMessageStream } from '../direct-api.js';
import { sendClaudeMessageWithMeta, sendClaudeStream, mapToClaudeModel, extractClaudeRateLimitHeaders } from '../claude-api.js';
import { listApiKeys, getProviderById, recordUsage, recordError, recordRateLimit } from '../api-key-manager.js';
import { resolveModel } from '../model-mapping.js';
import { getProviderModelOptions, normalizeProviderType } from '../model-options.js';
import { logger } from '../utils/logger.js';
// Legacy ordinary-chat assistant compatibility path only.
// /cligate supervisor logic belongs to assistant-core + assistant-agent.
import { prepareAssistantRequest } from '../assistant/assistant-chat-service.js';
import { createPendingAssistantAction, executePendingAssistantAction } from '../assistant/tool-executor.js';
import assistantPendingActionStore from '../assistant-core/pending-action-store.js';
import createBuiltinAssistantToolRegistry, {
  AssistantToolPolicyService,
  AssistantToolsExecutor
} from '../assistant-tools/index.js';
import agentChannelDeliveryStore from '../agent-channels/delivery-store.js';
import chatUiConversationService from '../chat-ui/conversation-service.js';
import chatUiConversationStore from '../chat-ui/conversation-store.js';
import assistantRunStore from '../assistant-core/run-store.js';
import artifactService from '../assistant-core/artifact-service.js';
import { ensurePendingAssistantAction } from '../assistant-core/pending-action-resolver.js';

function listPersistedUiChatMessages(conversation) {
  const messages = conversation?.metadata?.uiChatMessages;
  return Array.isArray(messages) ? messages : [];
}

function getPendingUiAssistantRunId(conversation) {
  return String(conversation?.metadata?.uiChatPendingAssistantRunId || '').trim();
}

function hasPersistedUiAssistantMessage(conversation, {
  assistantRunId = '',
  runStatus = '',
  content = ''
} = {}) {
  const normalizedRunId = String(assistantRunId || '').trim();
  const normalizedRunStatus = String(runStatus || '').trim();
  const normalizedContent = String(content || '').trim();
  return listPersistedUiChatMessages(conversation).some((message) => (
    String(message?.assistantRunId || '').trim() === normalizedRunId
    && String(message?.runStatus || '').trim() === normalizedRunStatus
    && String(message?.content || '').trim() === normalizedContent
  ));
}

function isAffirmativeConfirmation(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  return [
    /^(确认|同意|可以|查吧|行|好|继续|批准)\s*[.!。！]*$/i,
    /^(confirm|approve|yes|ok|okay|go ahead|continue)\s*[.!]*$/i
  ].some((pattern) => pattern.test(normalized));
}

// "Yolo" / sticky-approval phrases. When the user says one of these the
// supervisor's policy gate is flipped open for the rest of this conversation —
// every mutating tool call this conversation makes auto-approves without
// another confirmation roundtrip. The user can turn it back off with /safe.
//
// Patterns intentionally match intent rather than literal strings: users
// phrase the same idea many ways ("后续所有操作都同意", "任何操作都同意",
// "不用再问我了", "不要每一步都问", "直接执行"). The previous version of
// this list was too literal and missed all of these in the real conv
// 76fb84e0, leaving the user stuck in an endless confirmation loop.
const STICKY_APPROVAL_PATTERNS = Object.freeze([
  // (A) "Don't ask again" family — zh
  //   不要/不用/不需要 (再/每一步/每次/每一次)? (问/确认/询问/打断)
  /不\s*(要|用|需要|必)?\s*(再|每\s*[一]?\s*(次|步)|总是|一直)?\s*(问|确认|询问|打断|打扰)/,
  /别\s*(再|总)?\s*(问|确认|打断)/,
  /(后续|以后|今后|往后)\s*不\s*(要|用)?\s*再?\s*(问|确认|询问)/,
  // (B) Approval verb + sticky scope — zh
  //   "同意所有操作" / "批准所有" / "允许后续" / "放行全部"
  /(同意|允许|批准|放行|确认)\s*[，,、]?\s*(所有|全部|任何|后续|以后|一律|始终|永远|全程|每\s*[一]?\s*(次|步)?|后面|接下来|往后)/,
  // (C) Sticky scope ... approval verb — zh
  //   "后续所有操作都完全同意" / "任何操作都同意" / "所有都允许"
  /(所有|全部|任何|后续|以后|一律|始终|永远|全程|每\s*[一]?\s*(次|步)?|后面|接下来|往后)[^。.！!？?]{0,30}(同意|允许|批准|放行)/,
  // (D) "Just do it" family — zh
  /(直接|径直|径自|一路)\s*(执行|进行|做|跑|完成|继续|开始|同意|搞|干)/,
  // (E) Session-wide scope — zh
  /本\s*(次|会)?\s*(对话|会话|聊天|项目)[^。.！!？?]{0,15}(同意|允许|放行|批准|允许读取)/,
  // (F) English yolo / auto-approve family
  /\b(yolo|dangerously[\s-]?skip[\s-]?permissions?|auto[\s-]?approve|auto[\s-]?confirm|approve\s+(all|any|every|each|everything|anything)|always\s+(approve|allow)|allow\s+(all|any|every|everything)|don'?t\s+(keep\s+)?ask(ing)?\s+(me\s+)?(again|each|every|any)?|never\s+ask\s+(me\s+)?again|stop\s+asking|just\s+do\s+it|go\s+ahead\s+with\s+(all|everything)|from\s+now\s+on\s+(always|approve|allow|just\s+do\s+it))\b/i
]);

// Phrases that explicitly REVOKE / oppose sticky approval. If any of these
// fire we never treat the message as a yolo opt-in, even when other tokens
// leak through (e.g. "我不同意所有这些").
const STICKY_APPROVAL_DENY_PATTERNS = Object.freeze([
  /(不\s*同意|不\s*允许|不\s*批准|不\s*放行|拒绝|取消|别\s*同意|不要\s*同意|不要\s*允许)/,
  /\b(do\s+not\s+approve|don'?t\s+approve|deny|reject|cancel)\b/i
]);

export function hasStickyApprovalPhrase(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  if (STICKY_APPROVAL_DENY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return STICKY_APPROVAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function parseAssistantPermissionCommandForTest(text = '') {
  return parseAssistantPermissionCommand(text);
}

function parseAssistantPermissionCommand(text = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  if (/^\/(yolo|auto[-_]?approve|dangerously[-_]?skip[-_]?permissions?)\b/i.test(trimmed)) {
    return { command: 'yolo' };
  }
  if (/^\/(safe|safe[-_]?mode|require[-_]?approval|stop[-_]?yolo)\b/i.test(trimmed)) {
    return { command: 'safe' };
  }
  return null;
}

function getAutoApproveToolsState(conversation = null) {
  return Boolean(conversation?.metadata?.assistantCore?.autoApproveTools);
}

function applyAutoApproveToolsPatch(conversation = null, value = false) {
  if (!conversation?.id) return conversation;
  const next = chatUiConversationStore.patch(conversation.id, {
    metadata: {
      ...(conversation.metadata || {}),
      assistantCore: {
        ...((conversation?.metadata?.assistantCore && typeof conversation.metadata.assistantCore === 'object')
          ? conversation.metadata.assistantCore
          : {}),
        autoApproveTools: value === true,
        autoApproveToolsUpdatedAt: new Date().toISOString()
      }
    }
  });
  return next || conversation;
}

function buildAutoApproveAcknowledgement({ enabled, reason }) {
  const zh = /㐀-鿿/.test('确认') ? true : true; // always reply in zh-CN; user's UI is Chinese
  if (enabled) {
    if (reason === 'slash') {
      return zh
        ? '已开启自动同意模式（/yolo）。本会话内的所有后续工具调用都会自动放行，不会再向你确认。要恢复人工确认请发送 /safe。'
        : 'Auto-approve mode is now ON (/yolo). Every subsequent tool call in this conversation will execute without asking you. Send /safe to turn it back off.';
    }
    return zh
      ? '已开启自动同意模式。本会话内的所有后续工具调用都会自动放行，不会再向你确认。要恢复人工确认请发送 /safe。'
      : 'Auto-approve mode is now ON. Every subsequent tool call in this conversation will execute without asking you. Send /safe to turn it back off.';
  }
  return zh
    ? '已关闭自动同意模式（/safe）。后续敏感工具调用恢复为逐次确认。'
    : 'Auto-approve mode is now OFF (/safe). Sensitive tool calls will ask for confirmation again.';
}

function isExecutionToolPendingAction(action = {}) {
  return Boolean(
    action?.toolName
    && action?.input
    && !action?.input?.task
    && !action?.input?.message
  );
}

async function executeConfirmedExecutionToolAction(action = {}, { conversation = null } = {}) {
  const workspaceRoot = String(
    action?.input?.cwd
      || action?.input?.path
      || action?.metadata?.requestedPath
      || process.cwd()
  ).trim() || process.cwd();
  const { registry, workspaceGuard } = createBuiltinAssistantToolRegistry({
    workspaceRoot
  });
  const executor = new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: new AssistantToolPolicyService({
      workspaceGuard,
      allowMutatingTools: true
    })
  });
  const toolResult = await executor.executeToolCall({
    toolName: String(action.toolName || '').trim(),
    input: action.input || {},
    metadata: {
      approved: true
    }
  }, {
    cwd: workspaceRoot,
    autoApproveAll: getAutoApproveToolsState(conversation),
    extraReadRoots: []
  });
  return {
    type: 'assistant_execution_tool_confirmed',
    message: String(toolResult?.content?.[0]?.text || '').trim() || `Confirmed and executed ${action.toolName}.`,
    toolResult,
    assistantRun: {
      id: String(action.assistantRunId || '').trim(),
      status: toolResult?.status === 'completed' ? 'completed' : 'failed',
      result: String(toolResult?.content?.[0]?.text || '').trim(),
      summary: String(toolResult?.content?.[0]?.text || '').trim()
    },
    pendingAction: null
  };
}

function clearConversationPendingActionState(conversation = null) {
  if (!conversation?.id) {
    return conversation;
  }
  const messages = Array.isArray(conversation?.metadata?.uiChatMessages)
    ? conversation.metadata.uiChatMessages
    : [];
  const nextMessages = messages.map((message) => (
    message?.pendingAction
      ? { ...message, pendingAction: null }
      : message
  ));
  return chatUiConversationStore.patch(conversation.id, {
    metadata: {
      ...(conversation.metadata || {}),
      assistantCore: {
        ...((conversation?.metadata?.assistantCore && typeof conversation.metadata.assistantCore === 'object')
          ? conversation.metadata.assistantCore
          : {}),
        pendingActionConfirmToken: null
      },
      uiChatMessages: nextMessages
    }
  }) || conversation;
}

function resolveDefaultChatUiWorkspaceRoot() {
  return String(process.env.CLIGATE_DEFAULT_CHAT_UI_WORKSPACE || 'D:\\').trim() || process.cwd();
}

function normalizeChatAgentInputParts(inputParts = []) {
  if (!Array.isArray(inputParts)) return [];
  const normalized = [];
  for (const part of inputParts) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      const text = String(part.text || '').trim();
      if (!text) continue;
      normalized.push({
        type: 'text',
        text
      });
      continue;
    }
    if (part.type === 'input_image') {
      const imageUrl = String(part.image_url || part.url || '').trim();
      if (!imageUrl) continue;
      normalized.push({
        type: 'input_image',
        image_url: imageUrl,
        ...(String(part.media_type || '').trim()
          ? { media_type: String(part.media_type || '').trim() }
          : {})
      });
    }
  }
  return normalized;
}

function coerceChatAgentTextInput(input, inputParts = []) {
  const rawText = typeof input === 'string' ? input : '';
  const normalizedText = rawText.trim();
  if (normalizedText) return normalizedText;
  const textParts = normalizeChatAgentInputParts(inputParts)
    .filter((part) => part.type === 'text')
    .map((part) => String(part.text || '').trim())
    .filter(Boolean);
  return textParts.join('\n').trim();
}

function rebuildPendingActionFromRun(conversation = null) {
  return ensurePendingAssistantAction(conversation, {
    runStore: assistantRunStore,
    pendingActionStore: assistantPendingActionStore,
    conversationStore: chatUiConversationStore
  });
}

function buildDeliveryArtifactRefs(refs = []) {
  return Array.isArray(refs)
    ? refs
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
      .slice(0, 8)
    : [];
}

function saveChatUiInboundDelivery(conversation, {
  sessionId = '',
  text = '',
  runtimeSessionId = '',
  inputParts = null,
  artifactRefs = []
} = {}) {
  const content = String(text || '').trim();
  const normalizedInputParts = normalizeChatAgentInputParts(inputParts);
  const normalizedArtifactRefs = buildDeliveryArtifactRefs(artifactRefs);
  if (!conversation?.id || (!content && normalizedInputParts.length === 0)) return null;
  return agentChannelDeliveryStore.saveInbound({
    channel: 'chat-ui',
    conversationId: conversation.id,
    sessionId: String(runtimeSessionId || conversation.activeRuntimeSessionId || '').trim() || null,
    externalMessageId: `chat-ui-inbound:${sessionId || conversation.id}:${Date.now()}`,
    payload: {
      text: content,
      kind: 'chat_ui_assistant_turn',
      sourceType: 'chat-ui',
      ...(normalizedInputParts.length > 0 ? { inputParts: normalizedInputParts } : {}),
      ...(normalizedArtifactRefs.length > 0 ? { artifactRefs: normalizedArtifactRefs } : {})
    }
  });
}

function saveChatUiOutboundDelivery(conversation, {
  sessionId = '',
  text = '',
  runtimeSessionId = '',
  assistantRunId = '',
  runStatus = '',
  pendingAction = null,
  observability = null,
  contentParts = null,
  artifactRefs = []
} = {}) {
  const content = String(text || '').trim();
  const normalizedContentParts = normalizeChatAgentInputParts(contentParts);
  const normalizedArtifactRefs = buildDeliveryArtifactRefs(artifactRefs);
  if (!conversation?.id || (!content && normalizedContentParts.length === 0)) return null;
  return agentChannelDeliveryStore.saveOutbound({
    channel: 'chat-ui',
    conversationId: conversation.id,
    sessionId: String(runtimeSessionId || conversation.activeRuntimeSessionId || '').trim() || null,
    externalMessageId: `chat-ui-outbound:${sessionId || conversation.id}:${assistantRunId || 'direct'}:${Date.now()}`,
    payload: {
      text: content,
      fullText: content,
      kind: 'chat_ui_assistant_turn',
      sourceType: 'chat-ui',
      assistantRunId: String(assistantRunId || '').trim(),
      runStatus: String(runStatus || '').trim(),
      pendingAction,
      observability,
      ...(normalizedContentParts.length > 0 ? { contentParts: normalizedContentParts } : {}),
      ...(normalizedArtifactRefs.length > 0 ? { artifactRefs: normalizedArtifactRefs } : {})
    }
  });
}

export async function handleListChatSources(_req, res) {
  const chatgptSources = listAccounts().accounts
    .filter((account) => account.enabled !== false)
    .map((account) => ({
      id: `chatgpt:${account.email}`,
      kind: 'chatgpt-account',
      label: account.email,
      description: `ChatGPT account${account.isActive ? ' - active' : ''}`,
      meta: {
        email: account.email,
        planType: account.planType,
        isActive: account.isActive,
        providerType: 'openai',
        models: getProviderModelOptions('openai')
      }
    }));

  const claudeData = loadClaudeAccounts();
  const claudeSources = (claudeData.accounts || [])
    .filter((account) => account.enabled !== false)
    .map((account) => ({
      id: `claude:${account.email}`,
      kind: 'claude-account',
      label: account.displayName || account.email,
      description: `Claude account - ${account.email}`,
      meta: {
        email: account.email,
        subscriptionType: account.subscriptionType || 'free',
        isActive: account.email === claudeData.activeAccount,
        providerType: 'anthropic',
        models: getProviderModelOptions('anthropic')
      }
    }));

  const apiKeySources = listApiKeys()
    .filter((key) => key.enabled !== false)
    .map((key) => ({
      id: `apikey:${key.id}`,
      kind: 'api-key',
      label: key.name,
      description: `${key.type} - ${key.apiKey}`,
      meta: {
        keyId: key.id,
        providerType: normalizeProviderType(key.type),
        isAvailable: key.isAvailable,
        models: getProviderModelOptions(key.type)
      }
    }));

  const antigravityData = listAntigravityAccounts();
  const antigravitySources = (antigravityData.accounts || [])
    .filter((account) => account.enabled !== false)
    .map((account) => ({
      id: `antigravity:${account.email}`,
      kind: 'antigravity-account',
      label: account.displayName || account.email,
      description: `Antigravity account - ${account.email}`,
      meta: {
        email: account.email,
        subscriptionType: account.subscriptionType || 'unknown',
        isActive: account.email === antigravityData.activeAccount,
        providerType: 'gemini',
        models: (account.models || [])
          .map((model) => model.publicId || toPublicAntigravityModel(model.id))
          .filter(Boolean)
      }
    }));

  res.json({
    sources: [...chatgptSources, ...claudeSources, ...antigravitySources, ...apiKeySources]
  });
}

export async function handleChatWithSource(req, res) {
  const { sourceId, model, messages, temperature, assistantMode, uiLang, sessionId } = req.body || {};

  if (!sourceId || typeof sourceId !== 'string') {
    return res.status(400).json({ success: false, error: 'sourceId is required' });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ success: false, error: 'messages must be a non-empty array' });
  }

  const requestedModel = typeof model === 'string' && model.trim() ? model.trim() : 'gpt-5.2';
  const assistantRequest = assistantMode === true
    ? prepareAssistantRequest({ messages, uiLang, sessionId })
    : null;
  const outboundMessages = assistantRequest?.messages || messages;
  const citations = assistantRequest?.citations || [];
  const assistantMeta = assistantRequest
    ? {
        enabled: true,
        language: assistantRequest.language,
        intent: assistantRequest.intent?.type || 'general',
        citations
      }
    : null;

  if (assistantMode === true && assistantRequest?.intent?.type === 'preference_saved') {
    return res.json({
      success: true,
      source: {
        id: sourceId,
        kind: sourceId.split(':')[0],
        label: sourceId
      },
      model: requestedModel,
      assistant: assistantMeta,
      reply: {
        role: 'assistant',
        content: assistantRequest.preferenceMessage,
        model: requestedModel,
        citations,
        usage: null
      }
    });
  }

  if (assistantMode === true && assistantRequest?.intent?.type === 'tool_request' && assistantRequest.intent.actionName) {
    const pendingAction = createPendingAssistantAction(assistantRequest.intent.actionName, {
      language: assistantRequest.language,
      port: req.app?.locals?.port || req.socket?.localPort || 8081
    });

    return res.json({
      success: true,
      source: {
        id: sourceId,
        kind: sourceId.split(':')[0],
        label: sourceId
      },
      model: requestedModel,
      assistant: assistantMeta,
      reply: {
        role: 'assistant',
        content: assistantRequest.language === 'zh-CN'
          ? '我可以帮你执行这个操作，请先确认下面的动作。'
          : 'I can perform that action. Please confirm the pending action below first.',
        model: requestedModel,
        citations,
        pendingAction,
        usage: null
      }
    });
  }

  try {
    if (sourceId.startsWith('chatgpt:')) {
      const email = sourceId.slice('chatgpt:'.length);
      const creds = await getCredentialsForAccount(email);
      if (!creds) {
        return res.status(404).json({ success: false, error: `ChatGPT account not available: ${email}` });
      }

      const anthropicRequest = buildAnthropicRequest({
        model: requestedModel,
        messages: outboundMessages,
        temperature
      });

      const response = await sendMessage(anthropicRequest, creds.accessToken, creds.accountId);
      return res.json({
        success: true,
        source: {
          id: sourceId,
          kind: 'chatgpt-account',
          label: email
        },
        model: requestedModel,
        assistant: assistantMeta,
        reply: normalizeAnthropicResponse(response, requestedModel, { citations })
      });
    }

    if (sourceId.startsWith('claude:')) {
      const email = sourceId.slice('claude:'.length);
      const claudeData = loadClaudeAccounts();
      let account = (claudeData.accounts || []).find((item) => item.email === email && item.enabled !== false);
      if (!account?.accessToken) {
        return res.status(404).json({ success: false, error: `Claude account not available: ${email}` });
      }

      const upstreamModel = resolveModel('anthropic', requestedModel) || mapToClaudeModel(requestedModel);
      let response;

      try {
        const result = await sendClaudeMessageWithMeta(buildAnthropicRequest({
          model: upstreamModel,
          messages: outboundMessages,
          temperature
        }), account.accessToken);
        response = result.data;
        recordClaudeRuntimeObservation(account.email, result.rateLimitHeaders, { model: upstreamModel });
      } catch (error) {
        recordClaudeRuntimeObservation(account.email, error.rateLimitHeaders, { model: upstreamModel });
        if (!error.message?.startsWith('AUTH_EXPIRED')) {
          throw error;
        }

        const refreshResult = await refreshClaudeAccountToken(email);
        if (!refreshResult.success) {
          throw error;
        }

        account = getClaudeAccount(email) || account;
        const result = await sendClaudeMessageWithMeta(buildAnthropicRequest({
          model: upstreamModel,
          messages: outboundMessages,
          temperature
        }), account.accessToken);
        response = result.data;
        recordClaudeRuntimeObservation(account.email, result.rateLimitHeaders, { model: upstreamModel });
      }

      return res.json({
        success: true,
        source: {
          id: sourceId,
          kind: 'claude-account',
          label: account.displayName || email
        },
        model: requestedModel,
        mappedModel: upstreamModel,
        assistant: assistantMeta,
        reply: normalizeAnthropicResponse(response, requestedModel, { citations })
      });
    }

    if (sourceId.startsWith('antigravity:')) {
      const email = sourceId.slice('antigravity:'.length);
      let account = getAntigravityAccount(email);
      if (!account?.accessToken) {
        return res.status(404).json({ success: false, error: `Antigravity account not available: ${email}` });
      }
      await ensureAntigravityAccountProjectId(email);
      account = getAntigravityAccount(email) || account;

      try {
        const response = await sendAntigravityMessage(buildAnthropicRequest({
          model: requestedModel,
          messages: outboundMessages,
          temperature
        }), account, { modelOverride: requestedModel });
        return res.json({
          success: true,
          source: {
            id: sourceId,
            kind: 'antigravity-account',
            label: account.displayName || email
          },
          model: requestedModel,
          mappedModel: response.model || requestedModel,
          assistant: assistantMeta,
          reply: normalizeAnthropicResponse(response, requestedModel, { citations })
        });
      } catch (error) {
        if (!error.message?.startsWith('AUTH_EXPIRED')) throw error;
        const refreshResult = await refreshAntigravityAccountToken(email);
        if (!refreshResult.success) throw error;
        account = getAntigravityAccount(email) || account;
        const response = await sendAntigravityMessage(buildAnthropicRequest({
          model: requestedModel,
          messages: outboundMessages,
          temperature
        }), account, { modelOverride: requestedModel });
        return res.json({
          success: true,
          source: {
            id: sourceId,
            kind: 'antigravity-account',
            label: account.displayName || email
          },
          model: requestedModel,
          mappedModel: response.model || requestedModel,
          assistant: assistantMeta,
          reply: normalizeAnthropicResponse(response, requestedModel, { citations })
        });
      }
    }

    if (sourceId.startsWith('apikey:')) {
      const keyId = sourceId.slice('apikey:'.length);
      const provider = getProviderById(keyId);
      if (!provider || provider.enabled === false) {
        return res.status(404).json({ success: false, error: `API key not available: ${keyId}` });
      }

      const startTime = Date.now();
      const isAnthropic = provider.type === 'anthropic';
      const mappedModel = isAnthropic
        ? (resolveModel('anthropic', requestedModel) || mapToClaudeModel(requestedModel))
        : (resolveModel(provider.type, requestedModel) || requestedModel);
      const requestBody = isAnthropic
        ? buildAnthropicRequest({ model: mappedModel, messages: outboundMessages, temperature })
        : buildOpenAIChatRequest({ model: mappedModel, messages: outboundMessages, temperature });

      const response = await provider.sendRequest(requestBody);
      const durationMs = Date.now() - startTime;
      const responseText = await response.text();

      if (response.status === 429) {
        const retryAfter = response.headers?.get?.('retry-after');
        recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000);
      }

      if (!response.ok) {
        recordError(provider.id);
        return res.status(response.status).json({
          success: false,
          error: responseText || `Provider request failed with ${response.status}`
        });
      }

      const parsed = JSON.parse(responseText);
      const usage = isAnthropic
        ? {
            inputTokens: parsed.usage?.input_tokens || 0,
            outputTokens: parsed.usage?.output_tokens || 0
          }
        : {
            inputTokens: parsed.usage?.prompt_tokens || 0,
            outputTokens: parsed.usage?.completion_tokens || 0
          };

      recordUsage(provider.id, { ...usage, model: mappedModel });
      logger.info(`[ChatUI] OK via ${provider.type}/${provider.name} | ${requestedModel} -> ${mappedModel} | ${durationMs}ms`);

      return res.json({
        success: true,
        source: {
          id: sourceId,
          kind: 'api-key',
          label: provider.name
        },
        model: requestedModel,
        mappedModel,
        assistant: assistantMeta,
        reply: isAnthropic
          ? normalizeAnthropicResponse(parsed, requestedModel, { citations })
          : normalizeOpenAIResponse(parsed, requestedModel, { citations })
      });
    }

    return res.status(400).json({ success: false, error: `Unsupported sourceId: ${sourceId}` });
  } catch (error) {
    logger.error(`[ChatUI] ${sourceId} failed: ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function handleStreamChatWithSource(req, res) {
  const { sourceId, model, messages, temperature, assistantMode, uiLang, sessionId } = req.body || {};

  if (!sourceId || typeof sourceId !== 'string') {
    return res.status(400).json({ success: false, error: 'sourceId is required' });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ success: false, error: 'messages must be a non-empty array' });
  }

  const requestedModel = typeof model === 'string' && model.trim() ? model.trim() : 'gpt-5.2';
  const assistantRequest = assistantMode === true
    ? prepareAssistantRequest({ messages, uiLang, sessionId })
    : null;
  const outboundMessages = assistantRequest?.messages || messages;
  const citations = assistantRequest?.citations || [];
  const assistantMeta = assistantRequest
    ? {
        enabled: true,
        language: assistantRequest.language,
        intent: assistantRequest.intent?.type || 'general',
        citations
      }
    : null;

  prepareSseResponse(res);

  if (assistantMode === true && assistantRequest?.intent?.type === 'preference_saved') {
    writeSse(res, {
      type: 'start',
      source: { id: sourceId, kind: sourceId.split(':')[0], label: sourceId },
      model: requestedModel,
      assistant: assistantMeta
    });
    writeSse(res, {
      type: 'delta',
      text: assistantRequest.preferenceMessage
    });
    writeSse(res, {
      type: 'done',
      model: requestedModel,
      mappedModel: null,
      usage: null,
      citations
    });
    return res.end();
  }

  if (assistantMode === true && assistantRequest?.intent?.type === 'tool_request' && assistantRequest.intent.actionName) {
    const pendingAction = createPendingAssistantAction(assistantRequest.intent.actionName, {
      language: assistantRequest.language,
      port: req.app?.locals?.port || req.socket?.localPort || 8081
    });

    writeSse(res, {
      type: 'start',
      source: { id: sourceId, kind: sourceId.split(':')[0], label: sourceId },
      model: requestedModel,
      assistant: assistantMeta
    });
    writeSse(res, {
      type: 'delta',
      text: assistantRequest.language === 'zh-CN'
        ? '我可以帮你执行这个操作，请先确认下面的动作。'
        : 'I can perform that action. Please confirm the pending action below first.'
    });
    writeSse(res, {
      type: 'action_confirmation',
      pendingAction
    });
    writeSse(res, {
      type: 'done',
      model: requestedModel,
      mappedModel: null,
      usage: null,
      citations
    });
    return res.end();
  }

  try {
    if (sourceId.startsWith('chatgpt:')) {
      const email = sourceId.slice('chatgpt:'.length);
      const creds = await getCredentialsForAccount(email);
      if (!creds) {
        writeSse(res, { type: 'error', error: `ChatGPT account not available: ${email}` });
        return res.end();
      }

      writeSse(res, {
        type: 'start',
        source: { id: sourceId, kind: 'chatgpt-account', label: email },
        model: requestedModel,
        assistant: assistantMeta
      });

      const anthropicRequest = buildAnthropicRequest({
        model: requestedModel,
        messages: outboundMessages,
        temperature,
        stream: true
      });

      return await streamAnthropicEvents(
        sendMessageStream(anthropicRequest, creds.accessToken, creds.accountId),
        res,
        { requestedModel, citations }
      );
    }

    if (sourceId.startsWith('claude:')) {
      const email = sourceId.slice('claude:'.length);
      const claudeData = loadClaudeAccounts();
      let account = (claudeData.accounts || []).find((item) => item.email === email && item.enabled !== false);
      if (!account?.accessToken) {
        writeSse(res, { type: 'error', error: `Claude account not available: ${email}` });
        return res.end();
      }

      const upstreamModel = resolveModel('anthropic', requestedModel) || mapToClaudeModel(requestedModel);
      writeSse(res, {
        type: 'start',
        source: { id: sourceId, kind: 'claude-account', label: account.displayName || email },
        model: requestedModel,
        mappedModel: upstreamModel,
        assistant: assistantMeta
      });

      try {
        const response = await sendClaudeStream(buildAnthropicRequest({
          model: upstreamModel,
          messages: outboundMessages,
          temperature,
          stream: true
        }), account.accessToken);
        recordClaudeRuntimeObservation(account.email, extractClaudeRateLimitHeaders(response.headers), { model: upstreamModel });
        return await streamAnthropicResponse(response, res, {
          requestedModel,
          mappedModel: upstreamModel,
          citations
        });
      } catch (error) {
        recordClaudeRuntimeObservation(account.email, error.rateLimitHeaders, { model: upstreamModel });
        if (!error.message?.startsWith('AUTH_EXPIRED')) {
          throw error;
        }

        const refreshResult = await refreshClaudeAccountToken(email);
        if (!refreshResult.success) {
          throw error;
        }

        account = getClaudeAccount(email) || account;
        const retryResponse = await sendClaudeStream(buildAnthropicRequest({
          model: upstreamModel,
          messages: outboundMessages,
          temperature,
          stream: true
        }), account.accessToken);
        recordClaudeRuntimeObservation(account.email, extractClaudeRateLimitHeaders(retryResponse.headers), { model: upstreamModel });
        return await streamAnthropicResponse(retryResponse, res, {
          requestedModel,
          mappedModel: upstreamModel,
          citations
        });
      }
    }

    if (sourceId.startsWith('antigravity:')) {
      const email = sourceId.slice('antigravity:'.length);
      let account = getAntigravityAccount(email);
      if (!account?.accessToken) {
        writeSse(res, { type: 'error', error: `Antigravity account not available: ${email}` });
        return res.end();
      }
      await ensureAntigravityAccountProjectId(email);
      account = getAntigravityAccount(email) || account;

      writeSse(res, {
        type: 'start',
        source: { id: sourceId, kind: 'antigravity-account', label: account.displayName || email },
        model: requestedModel,
        assistant: assistantMeta
      });

      try {
        const response = await sendAntigravityMessage(buildAnthropicRequest({
          model: requestedModel,
          messages: outboundMessages,
          temperature
        }), account, { modelOverride: requestedModel });
        const reply = normalizeAnthropicResponse(response, requestedModel, { citations });
        if (reply.content) {
          writeSse(res, { type: 'delta', text: reply.content });
        }
        writeSse(res, {
          type: 'done',
          model: requestedModel,
          mappedModel: response.model || requestedModel,
          usage: reply.usage || null,
          citations: reply.citations || []
        });
        return res.end();
      } catch (error) {
        if (!error.message?.startsWith('AUTH_EXPIRED')) throw error;
        const refreshResult = await refreshAntigravityAccountToken(email);
        if (!refreshResult.success) throw error;
        account = getAntigravityAccount(email) || account;
        const response = await sendAntigravityMessage(buildAnthropicRequest({
          model: requestedModel,
          messages: outboundMessages,
          temperature
        }), account, { modelOverride: requestedModel });
        const reply = normalizeAnthropicResponse(response, requestedModel, { citations });
        if (reply.content) {
          writeSse(res, { type: 'delta', text: reply.content });
        }
        writeSse(res, {
          type: 'done',
          model: requestedModel,
          mappedModel: response.model || requestedModel,
          usage: reply.usage || null,
          citations: reply.citations || []
        });
        return res.end();
      }
    }

    if (sourceId.startsWith('apikey:')) {
      const keyId = sourceId.slice('apikey:'.length);
      const provider = getProviderById(keyId);
      if (!provider || provider.enabled === false) {
        writeSse(res, { type: 'error', error: `API key not available: ${keyId}` });
        return res.end();
      }

      const isAnthropic = provider.type === 'anthropic';
      const mappedModel = isAnthropic
        ? (resolveModel('anthropic', requestedModel) || mapToClaudeModel(requestedModel))
        : (resolveModel(provider.type, requestedModel) || requestedModel);

      writeSse(res, {
        type: 'start',
        source: { id: sourceId, kind: 'api-key', label: provider.name },
        model: requestedModel,
        mappedModel,
        assistant: assistantMeta
      });

      const startTime = Date.now();
      if (isAnthropic) {
        const response = await provider.sendRequest(buildAnthropicRequest({
          model: mappedModel,
          messages: outboundMessages,
          temperature,
          stream: true
        }), { stream: true });

        if (!response.ok) {
          const errorText = await response.text();
          if (response.status === 429) {
            const retryAfter = response.headers?.get?.('retry-after');
            recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000);
          }
          recordError(provider.id);
          writeSse(res, { type: 'error', error: errorText || `Provider request failed with ${response.status}` });
          return res.end();
        }

        return await streamAnthropicResponse(response, res, {
          requestedModel,
          mappedModel,
          provider,
          startedAt: startTime,
          citations
        });
      }

      const response = await provider.sendRequest(buildOpenAIChatRequest({
        model: mappedModel,
        messages: outboundMessages,
        temperature,
        stream: true
      }), { stream: true });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 429) {
          const retryAfter = response.headers?.get?.('retry-after');
          recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000);
        }
        recordError(provider.id);
        writeSse(res, { type: 'error', error: errorText || `Provider request failed with ${response.status}` });
        return res.end();
      }

      const contentType = response.headers?.get?.('content-type') || '';
      if (contentType.includes('text/event-stream')) {
        return await streamOpenAIResponse(response, res, {
          requestedModel,
          mappedModel,
          provider,
          startedAt: startTime,
          citations
        });
      }

      const responseText = await response.text();
      const parsed = JSON.parse(responseText);
      const usage = {
        inputTokens: parsed.usage?.prompt_tokens || 0,
        outputTokens: parsed.usage?.completion_tokens || 0
      };

      recordUsage(provider.id, { ...usage, model: mappedModel });
      logger.info(`[ChatUI] stream fallback via ${provider.type}/${provider.name} | ${requestedModel} -> ${mappedModel} | ${Date.now() - startTime}ms`);

      const reply = normalizeOpenAIResponse(parsed, requestedModel, { citations });
      if (reply.content) {
        writeSse(res, { type: 'delta', text: reply.content });
      }
      writeSse(res, {
        type: 'done',
        model: requestedModel,
        mappedModel,
        usage: reply.usage || null,
        citations: reply.citations || []
      });
      return res.end();
    }

    writeSse(res, { type: 'error', error: `Unsupported sourceId: ${sourceId}` });
    return res.end();
  } catch (error) {
    logger.error(`[ChatUI] stream ${sourceId} failed: ${error.message}`);
    writeSse(res, { type: 'error', error: error.message });
    return res.end();
  }
}

function buildOpenAIChatRequest({ model, messages, temperature, stream = false }) {
  const body = {
    model,
    messages: sanitizeOpenAIMessages(messages)
  };

  if (typeof temperature === 'number') {
    body.temperature = temperature;
  }

  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  return body;
}

function buildAnthropicRequest({ model, messages, temperature, stream = false }) {
  const body = {
    model,
    messages: [],
    stream
  };

  const sanitizedMessages = sanitizeOpenAIMessages(messages);
  const systemMessages = sanitizedMessages.filter((msg) => msg.role === 'system');

  if (systemMessages.length > 0) {
    body.system = systemMessages.map((msg) => msg.content).join('\n\n');
  }

  body.messages = sanitizedMessages
    .filter((msg) => msg.role !== 'system')
    .map((msg) => ({
      role: msg.role === 'tool' ? 'user' : msg.role,
      content: coerceAnthropicContent(msg)
    }));

  if (typeof temperature === 'number') {
    body.temperature = temperature;
  }

  return body;
}

function sanitizeOpenAIMessages(messages) {
  return messages
    .filter((msg) => msg && typeof msg.role === 'string')
    .map((msg) => ({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : coerceTextContent(msg.content)
    }))
    .filter((msg) => msg.content);
}

function coerceAnthropicContent(message) {
  if (message.role === 'assistant') {
    return [{ type: 'text', text: message.content }];
  }
  return message.content;
}

function coerceTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item?.type === 'text') return item.text || '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function normalizeAnthropicResponse(response, requestedModel, { citations = [] } = {}) {
  const text = (response.content || [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('\n\n');

  return {
    role: 'assistant',
    content: text,
    model: requestedModel,
    citations,
    usage: {
      prompt_tokens: response.usage?.input_tokens || 0,
      completion_tokens: response.usage?.output_tokens || 0,
      total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)
    }
  };
}

function normalizeOpenAIResponse(response, requestedModel, { citations = [] } = {}) {
  const choice = response.choices?.[0];
  return {
    role: 'assistant',
    content: choice?.message?.content || '',
    model: requestedModel,
    citations,
    usage: {
      prompt_tokens: response.usage?.prompt_tokens || 0,
      completion_tokens: response.usage?.completion_tokens || 0,
      total_tokens: response.usage?.total_tokens
        || ((response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0))
    }
  };
}

function prepareSseResponse(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamAnthropicEvents(eventIterator, res, { requestedModel, mappedModel = null, provider = null, startedAt = Date.now(), citations = [] }) {
  let usage = null;
  let streamedText = false;

  for await (const event of eventIterator) {
    if (event?.event === 'content_block_delta' && event.data?.delta?.type === 'text_delta') {
      const text = event.data.delta.text || '';
      if (text) {
        streamedText = true;
        writeSse(res, { type: 'delta', text });
      }
    }

    if (event?.event === 'message_delta' && event.data?.usage) {
      usage = {
        prompt_tokens: event.data.usage.input_tokens || event.data.usage.prompt_tokens || 0,
        completion_tokens: event.data.usage.output_tokens || event.data.usage.completion_tokens || 0,
        total_tokens: (event.data.usage.input_tokens || event.data.usage.prompt_tokens || 0)
          + (event.data.usage.output_tokens || event.data.usage.completion_tokens || 0)
      };
    }
  }

  if (provider && usage) {
    recordUsage(provider.id, {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      model: mappedModel || requestedModel
    });
    logger.info(`[ChatUI] stream via ${provider.type}/${provider.name} | ${requestedModel} -> ${mappedModel || requestedModel} | ${Date.now() - startedAt}ms`);
  }

  if (!streamedText) {
    writeSse(res, { type: 'delta', text: '' });
  }
  writeSse(res, { type: 'done', model: requestedModel, mappedModel, usage, citations });
  res.end();
}

export async function handleConfirmAssistantToolAction(req, res) {
  const { confirmToken } = req.body || {};

  if (typeof confirmToken !== 'string' || !confirmToken.trim()) {
    return res.status(400).json({
      success: false,
      error: 'confirmToken is required'
    });
  }

  const normalizedToken = confirmToken.trim();
  const assistantPendingAction = assistantPendingActionStore.consume(normalizedToken);
  if (assistantPendingAction) {
    if (isExecutionToolPendingAction(assistantPendingAction)) {
      const conversation = assistantPendingAction.conversationId
        ? chatUiConversationStore.get(assistantPendingAction.conversationId)
        : null;
      try {
        const routeResult = await executeConfirmedExecutionToolAction(assistantPendingAction, { conversation });
        clearConversationPendingActionState(conversation);
        return res.json({
          success: true,
          result: routeResult?.message || `Confirmed and executed ${assistantPendingAction.toolName}.`,
          routeResult
        });
      } catch (error) {
        return res.status(500).json({
          success: false,
          error: error?.message || 'assistant execution-tool confirmation failed'
        });
      }
    }

    const conversation = assistantPendingAction.conversationId
      ? chatUiConversationStore.get(assistantPendingAction.conversationId)
      : null;
    try {
      const routeResult = await chatUiConversationService.routeMessage({
        sessionId: conversation?.externalConversationId || '',
        text: String(assistantPendingAction.input?.task || assistantPendingAction.input?.message || '').trim(),
        defaultRuntimeProvider: String(assistantPendingAction.input?.provider || 'codex').trim() || 'codex',
        cwd: String(assistantPendingAction.input?.cwd || '').trim(),
        model: String(assistantPendingAction.input?.model || '').trim(),
        assistantExecutionMode: 'sync',
        metadata: {
          assistantMode: 'direct-runtime'
        }
      });

      return res.json({
        success: true,
        result: routeResult?.message || routeResult?.assistantRun?.result || 'Confirmed and continued.',
        routeResult
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error?.message || 'assistant confirmation execution failed'
      });
    }
  }

  const result = await executePendingAssistantAction(normalizedToken);
  if (!result.success) {
    return res.status(400).json(result);
  }

  return res.json(result);
}

export async function handleGetChatAgentSession(req, res) {
  const sessionId = String(req.params.sessionId || '').trim();
  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: 'sessionId is required'
    });
  }

  const conversation = chatUiConversationStore.getBySessionId(sessionId);
  if (!conversation) {
    return res.status(404).json({
      success: false,
      error: 'chat session not found'
    });
  }

  return res.json({
    success: true,
    session: {
      sessionId,
      conversationId: conversation.id,
      activeRuntimeSessionId: conversation.activeRuntimeSessionId || '',
      assistantState: conversation.metadata?.assistantCore || null,
      uiChatMessages: listPersistedUiChatMessages(conversation)
    }
  });
}

export async function handleRouteChatAgentMessage(req, res) {
  try {
    const {
      sessionId,
      input,
      inputParts,
      provider,
      cwd,
      model
    } = req.body || {};

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }

    const normalizedInputParts = normalizeChatAgentInputParts(inputParts);
    const normalizedInputText = coerceChatAgentTextInput(input, normalizedInputParts);
    if (!normalizedInputText && normalizedInputParts.length === 0) {
      return res.status(400).json({ success: false, error: 'input or inputParts is required' });
    }

    const existingConversation = chatUiConversationStore.getBySessionId(sessionId);
    // `let` because the sticky-approval branch below reassigns it after
    // `applyAutoApproveToolsPatch`. Declaring this `const` was a latent bug:
    // the moment a user typed something like "本次对话都允许" or "同意后续所有
    // 操作", the reassignment threw `TypeError: Assignment to constant variable`,
    // the route returned 500, and no assistant run was ever created — the user
    // saw no reply at all (only the toast). The autoApproveTools metadata
    // patch DID land in the store because applyAutoApproveToolsPatch runs the
    // patch BEFORE the assignment, which is also why we observed conversations
    // with autoApproveTools=true yet zero downstream runs.
    let conversation = existingConversation || chatUiConversationStore.findOrCreateBySessionId(sessionId);
    const createdArtifacts = normalizedInputParts
      .filter((part) => part.type === 'input_image' && String(part.image_url || '').trim())
      .map((part, index) => artifactService.createArtifact({
        kind: 'image',
        source: 'chat_ui_upload',
        conversationId: conversation.id,
        role: 'user',
        title: normalizedInputText || `chat image ${index + 1}`,
        summary: normalizedInputText || 'User attached an image in chat-ui.',
        mediaType: String(part.media_type || '').trim()
          || (String(part.image_url || '').match(/^data:([^;]+);base64,/i)?.[1] || ''),
        imageUrl: String(part.image_url || '').trim(),
        metadata: {
          sourceType: 'chat-ui',
          sessionId
        }
      }));
    saveChatUiInboundDelivery(conversation, {
      sessionId,
      text: normalizedInputText || '[image attachment]',
      inputParts: normalizedInputParts,
      artifactRefs: createdArtifacts.map((entry) => entry.id)
    });

    // Permission-mode slash commands: /yolo (auto-approve), /safe (revert).
    // Handle these BEFORE any other routing so the user can toggle the flag
    // mid-conversation without dragging the supervisor into it.
    const permissionCommand = parseAssistantPermissionCommand(normalizedInputText);
    if (permissionCommand) {
      const enable = permissionCommand.command === 'yolo';
      const patchedConversation = applyAutoApproveToolsPatch(conversation, enable);
      const message = buildAutoApproveAcknowledgement({ enabled: enable, reason: 'slash' });
      saveChatUiOutboundDelivery(patchedConversation, {
        sessionId,
        text: message,
        assistantRunId: '',
        runStatus: 'completed'
      });
      return res.json({
        success: true,
        result: {
          type: 'assistant_response',
          message,
          assistantRun: null,
          pendingAction: null,
          observability: { autoApproveTools: enable }
        }
      });
    }

    // Natural-language sticky approval: phrases like "本次对话都允许 / 同意后续
    // 所有操作, 不要再问我了 / from now on always / yolo" set the conversation
    // flag and then let the original message continue into the supervisor LLM,
    // so the user gets the work done AND no more confirmation prompts in this
    // conversation.
    let autoApproveJustEnabled = false;
    if (
      !getAutoApproveToolsState(conversation)
      && hasStickyApprovalPhrase(normalizedInputText)
    ) {
      conversation = applyAutoApproveToolsPatch(conversation, true);
      autoApproveJustEnabled = true;
    }

    let latestAssistantPendingAction = existingConversation?.id
      ? assistantPendingActionStore.findLatestByConversationId(existingConversation.id)
      : null;
    if (!latestAssistantPendingAction && existingConversation?.id) {
      latestAssistantPendingAction = rebuildPendingActionFromRun(existingConversation);
    }
    if (latestAssistantPendingAction && isAffirmativeConfirmation(normalizedInputText)) {
      const confirmed = await handleConfirmAssistantToolAction({
        body: {
          confirmToken: latestAssistantPendingAction.confirmToken
        }
      }, {
        status(code) {
          this._status = code;
          return this;
        },
        json(payload) {
          this._body = payload;
          return this;
        },
        _status: 200,
        _body: null
      });
      return res.json({
        success: true,
        result: {
          type: 'assistant_response',
          message: confirmed?._body?.result || confirmed?._body?.routeResult?.message || 'Confirmed.',
          assistantRun: confirmed?._body?.routeResult?.assistantRun || null,
          pendingAction: null,
          observability: confirmed?._body?.routeResult?.observability || null
        }
      });
    }

    const result = await chatUiConversationService.routeMessage({
      sessionId,
      text: normalizedInputText,
      inputParts: normalizedInputParts,
      defaultRuntimeProvider: String(provider || 'codex'),
      cwd: String(cwd || '').trim() || resolveDefaultChatUiWorkspaceRoot(),
      model: String(model || ''),
      assistantExecutionMode: 'async',
      metadata: {
        ui: {
          origin: 'chat-ui'
        }
      },
      onBackgroundResult: async (backgroundResult) => {
        const conversation = chatUiConversationStore.findOrCreateBySessionId(sessionId);
        const backgroundRunId = String(backgroundResult?.assistantRun?.id || '').trim();
        if (!conversation?.metadata || !backgroundRunId) {
          return;
        }
        if (getPendingUiAssistantRunId(conversation) !== backgroundRunId) {
          return;
        }

        const messageContent = String(backgroundResult?.message || '').trim();
        if (hasPersistedUiAssistantMessage(conversation, {
          assistantRunId: backgroundRunId,
          runStatus: backgroundResult?.assistantRun?.status || '',
          content: messageContent
        })) {
          return;
        }

        const messages = Array.isArray(conversation?.metadata?.uiChatMessages)
          ? conversation.metadata.uiChatMessages
          : [];
        const runStatus = String(backgroundResult?.assistantRun?.status || '').trim();
        const nextPendingRunId = ['completed', 'failed', 'cancelled', 'waiting_user'].includes(runStatus)
          ? ''
          : backgroundRunId;
        saveChatUiOutboundDelivery(conversation, {
          sessionId,
          text: messageContent,
          runtimeSessionId: String(backgroundResult?.session?.id || conversation.activeRuntimeSessionId || '').trim(),
          assistantRunId: backgroundRunId,
          runStatus,
          pendingAction: backgroundResult?.pendingAction || null,
          observability: backgroundResult?.observability || null
        });
        chatUiConversationStore.patch(conversation.id, {
          metadata: {
            ...(conversation.metadata || {}),
            uiChatPendingAssistantRunId: nextPendingRunId,
            uiChatMessages: [
              ...messages,
              {
                role: 'assistant',
                kind: 'agent-message',
                content: messageContent,
                assistantRunId: backgroundRunId,
                runStatus,
                pendingAction: backgroundResult?.pendingAction || null,
                observability: backgroundResult?.observability || null,
                createdAt: new Date().toISOString()
              }
            ]
          }
        });
      }
    });

    if (result?.type === 'assistant_response' && result?.message) {
      const responseConversation = result?.conversation?.id
        ? (chatUiConversationStore.get(result.conversation.id) || conversation)
        : conversation;
      saveChatUiOutboundDelivery(responseConversation, {
        sessionId,
        text: result.message,
        runtimeSessionId: String(result?.session?.id || responseConversation?.activeRuntimeSessionId || '').trim(),
        assistantRunId: String(result?.assistantRun?.id || '').trim(),
        runStatus: String(result?.assistantRun?.status || '').trim(),
        pendingAction: result?.pendingAction || null,
        observability: result?.observability || null
      });
    }

    if (result?.type === 'assistant_run_accepted' && result?.assistantRun?.id) {
      const conversation = result?.conversation?.id
        ? (chatUiConversationStore.get(result.conversation.id) || chatUiConversationStore.findOrCreateBySessionId(sessionId))
        : chatUiConversationStore.findOrCreateBySessionId(sessionId);
      if (conversation?.metadata) {
        chatUiConversationStore.patch(conversation.id, {
          metadata: {
            ...(conversation.metadata || {}),
            uiChatPendingAssistantRunId: String(result.assistantRun.id || '').trim()
          }
        });
      }
    } else if (result?.conversation?.id) {
      const conversation = chatUiConversationStore.get(result.conversation.id);
      if (conversation?.metadata && getPendingUiAssistantRunId(conversation)) {
        chatUiConversationStore.patch(conversation.id, {
          metadata: {
            ...(conversation.metadata || {}),
            uiChatPendingAssistantRunId: ''
          }
        });
      }
    }

    return res.json({
      success: true,
      result
    });
  } catch (error) {
    const status = /required|not found|unsupported|usage/i.test(String(error.message || ''))
      ? 400
      : 500;
    return res.status(status).json({
      success: false,
      error: error.message
    });
  }
}

async function streamAnthropicResponse(response, res, options) {
  return streamAnthropicEvents(parseAnthropicStream(response), res, options);
}

async function* parseAnthropicStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = 'message';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const boundary = /\r?\n\r?\n/g;
    let lastIndex = 0;
    let match;
    const chunks = [];

    while ((match = boundary.exec(buffer)) !== null) {
      chunks.push(buffer.slice(lastIndex, match.index));
      lastIndex = match.index + match[0].length;
    }

    buffer = buffer.slice(lastIndex);

    for (const chunk of chunks) {
      const lines = chunk.split(/\r?\n/);
      let dataLine = '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLine += line.slice(5).trim();
        }
      }

      if (!dataLine || dataLine === '[DONE]') continue;

      try {
        yield {
          event: currentEvent,
          data: JSON.parse(dataLine)
        };
      } catch {
        // ignore malformed upstream chunk
      }
    }
  }
}

async function streamOpenAIResponse(response, res, { requestedModel, mappedModel = null, provider = null, startedAt = Date.now(), citations = [] }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  let streamedText = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        const event = JSON.parse(payload);
        const choice = event.choices?.[0];
        const text = choice?.delta?.content;
        if (text) {
          streamedText = true;
          writeSse(res, { type: 'delta', text });
        }

        if (event.usage) {
          usage = {
            prompt_tokens: event.usage.prompt_tokens || 0,
            completion_tokens: event.usage.completion_tokens || 0,
            total_tokens: event.usage.total_tokens
              || ((event.usage.prompt_tokens || 0) + (event.usage.completion_tokens || 0))
          };
        }
      } catch {
        // ignore malformed upstream chunk
      }
    }
  }

  if (provider && usage) {
    recordUsage(provider.id, {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      model: mappedModel || requestedModel
    });
    logger.info(`[ChatUI] stream via ${provider.type}/${provider.name} | ${requestedModel} -> ${mappedModel || requestedModel} | ${Date.now() - startedAt}ms`);
  }

  if (!streamedText) {
    writeSse(res, { type: 'delta', text: '' });
  }
  writeSse(res, { type: 'done', model: requestedModel, mappedModel, usage, citations });
  res.end();
}

export default {
  handleListChatSources,
  handleChatWithSource,
  handleStreamChatWithSource,
  handleConfirmAssistantToolAction,
  handleGetChatAgentSession,
  handleRouteChatAgentMessage
};
