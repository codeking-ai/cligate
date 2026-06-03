// Single source of truth for the conversation-level "auto-approve / yolo" gate.
//
// When the user grants blanket consent, the supervisor's per-tool confirmation
// prompt is flipped open for the rest of the conversation: every mutating tool
// call auto-approves without another roundtrip. The flag lives on
// `conversation.metadata.assistantCore.autoApproveTools` and is read by the
// ReAct engine (autoApproveAll). Both the web chat route AND the channel router
// (DingTalk/Feishu/Telegram) drive it through these helpers so the matching
// logic never diverges between surfaces.

// "Yolo" / sticky-approval phrases. Patterns match intent rather than literal
// strings: users phrase the same idea many ways ("后续所有操作都同意",
// "任何操作都同意", "不用再问我了", "不要每一步都问", "直接执行").
const STICKY_APPROVAL_PATTERNS = Object.freeze([
  // (A) "Don't ask again" family — zh
  /不\s*(要|用|需要|必)?\s*(再|每\s*[一]?\s*(次|步)|总是|一直)?\s*(问|确认|询问|打断|打扰)/,
  /别\s*(再|总)?\s*(问|确认|打断)/,
  /(后续|以后|今后|往后)\s*不\s*(要|用)?\s*再?\s*(问|确认|询问)/,
  // (B) Approval verb + sticky scope — zh
  /(同意|允许|批准|放行|确认)\s*[，,、]?\s*(所有|全部|任何|后续|以后|一律|始终|永远|全程|每\s*[一]?\s*(次|步)?|后面|接下来|往后)/,
  // (C) Sticky scope ... approval verb — zh
  /(所有|全部|任何|后续|以后|一律|始终|永远|全程|每\s*[一]?\s*(次|步)?|后面|接下来|往后)[^。.！!？?]{0,30}(同意|允许|批准|放行)/,
  // (D) "Just do it" family — zh
  /(直接|径直|径自|一路)\s*(执行|进行|做|跑|完成|继续|开始|同意|搞|干)/,
  // (E) Session-wide scope — zh
  /本\s*(次|会)?\s*(对话|会话|聊天|项目)[^。.！!？?]{0,15}(同意|允许|放行|批准|允许读取)/,
  // (F) English yolo / auto-approve family
  /\b(yolo|dangerously[\s-]?skip[\s-]?permissions?|auto[\s-]?approve|auto[\s-]?confirm|approve\s+(all|any|every|each|everything|anything)|always\s+(approve|allow)|allow\s+(all|any|every|everything)|don'?t\s+(keep\s+)?ask(ing)?\s+(me\s+)?(again|each|every|any)?|never\s+ask\s+(me\s+)?again|stop\s+asking|just\s+do\s+it|go\s+ahead\s+with\s+(all|everything)|from\s+now\s+on\s+(always|approve|allow|just\s+do\s+it))\b/i
]);

// Phrases that explicitly REVOKE / oppose sticky approval. If any fire we never
// treat the message as a yolo opt-in, even when other tokens leak through
// (e.g. "我不同意所有这些").
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

// Slash commands that toggle the gate explicitly: /yolo (on), /safe (off).
export function parseAssistantPermissionCommand(text = '') {
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

export function getAutoApproveToolsState(conversation = null) {
  return Boolean(conversation?.metadata?.assistantCore?.autoApproveTools);
}

// Pure metadata builder — returns the merged `metadata` object to persist. The
// caller owns the store (chat-ui vs channel conversation store), so this stays
// store-agnostic and side-effect free.
export function buildAutoApproveToolsMetadata(conversation = null, value = false, { now = '' } = {}) {
  const current = (conversation?.metadata && typeof conversation.metadata === 'object')
    ? conversation.metadata
    : {};
  const currentAssistantCore = (current.assistantCore && typeof current.assistantCore === 'object')
    ? current.assistantCore
    : {};
  return {
    ...current,
    assistantCore: {
      ...currentAssistantCore,
      autoApproveTools: value === true,
      autoApproveToolsUpdatedAt: String(now || '')
    }
  };
}

export function buildAutoApproveAcknowledgement({ enabled = false, reason = '', zh = true } = {}) {
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

export default {
  hasStickyApprovalPhrase,
  parseAssistantPermissionCommand,
  getAutoApproveToolsState,
  buildAutoApproveToolsMetadata,
  buildAutoApproveAcknowledgement
};
