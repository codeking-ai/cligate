// Pure, side-effect-free helpers for the "scheduled-task resume bridge".
//
// Why this exists: a scheduled `invoke_assistant` task runs in its OWN hidden
// scope conversation (channel `scheduled-task-scope`), NOT in the conversation
// the user chats in. When such a run genuinely pauses to ask the user something
// (waiting_user / waiting_approval), the user only sees a "⏳ 待处理" ping in the
// NOTIFY conversation (e.g. DingTalk). A plain reply there would otherwise hit
// that conversation's own focus task (the昨晚 mis-route), never the paused run.
//
// To bridge that safely we record, on the NOTIFY conversation, an explicit
// binding for each task that is waiting on the user: {scheduledTaskId,
// scopeConversationId, runId, title}. A reply is then resolved against this
// list with strict rules (single → resume; multiple → match by title or ask;
// never guess). Persisting it as plain metadata keeps the binding durable
// across restarts and decoupled from runtime session lifetimes.

function isObject(value) {
  return value && typeof value === 'object';
}

function toText(value) {
  return String(value || '').trim();
}

export function listPendingScheduledPrompts(conversation = null) {
  const list = conversation?.metadata?.assistantCore?.pendingScheduledPrompts;
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry) => isObject(entry)
      && toText(entry.scheduledTaskId)
      && toText(entry.scopeConversationId))
    .map((entry) => ({
      scheduledTaskId: toText(entry.scheduledTaskId),
      scopeConversationId: toText(entry.scopeConversationId),
      runId: toText(entry.runId),
      title: toText(entry.title),
      createdAt: toText(entry.createdAt)
    }));
}

export function buildPendingScheduledPromptsMetadata(conversation = null, prompts = []) {
  const current = isObject(conversation?.metadata) ? conversation.metadata : {};
  const core = isObject(current.assistantCore) ? current.assistantCore : {};
  return {
    ...current,
    assistantCore: {
      ...core,
      pendingScheduledPrompts: Array.isArray(prompts) ? prompts : []
    }
  };
}

// Insert/replace a prompt keyed by scheduledTaskId (latest wins). Returns the
// merged metadata object for the caller to persist.
export function addPendingScheduledPrompt(conversation = null, entry = {}) {
  const scheduledTaskId = toText(entry.scheduledTaskId);
  const scopeConversationId = toText(entry.scopeConversationId);
  if (!scheduledTaskId || !scopeConversationId) {
    return isObject(conversation?.metadata) ? conversation.metadata : {};
  }
  const others = listPendingScheduledPrompts(conversation)
    .filter((existing) => existing.scheduledTaskId !== scheduledTaskId);
  const next = [
    ...others,
    {
      scheduledTaskId,
      scopeConversationId,
      runId: toText(entry.runId),
      title: toText(entry.title),
      createdAt: toText(entry.createdAt)
    }
  ];
  return buildPendingScheduledPromptsMetadata(conversation, next);
}

export function removePendingScheduledPrompt(conversation = null, scheduledTaskId = '') {
  const id = toText(scheduledTaskId);
  const next = listPendingScheduledPrompts(conversation)
    .filter((existing) => existing.scheduledTaskId !== id);
  return buildPendingScheduledPromptsMetadata(conversation, next);
}

function normalizeComparable(value) {
  return toText(value)
    .toLowerCase()
    .replace(/[^a-z0-9㐀-鿿]+/g, ' ')
    .trim();
}

// Build comparable tokens that work for BOTH latin words and CJK. Latin/digit
// words (len>=2) are kept whole; CJK runs (which have no spaces) are reduced to
// character bigrams so a reply like "备份那个继续" can match a title like
// "同步数据库备份" via the shared bigram "备份".
function comparableTokens(value) {
  const normalized = normalizeComparable(value);
  if (!normalized) return [];
  const tokens = new Set();
  for (const word of normalized.split(/\s+/)) {
    if (word.length >= 2 && /[a-z0-9]/.test(word)) {
      tokens.add(word);
    }
  }
  const cjk = normalized.replace(/[^㐀-鿿]/g, '');
  for (let index = 0; index + 1 < cjk.length; index += 1) {
    tokens.add(cjk.slice(index, index + 2));
  }
  return [...tokens];
}

function titleMatchScore(text, title) {
  const haystack = new Set(comparableTokens(text));
  if (haystack.size === 0) return 0;
  const titleTokens = comparableTokens(title);
  if (titleTokens.length === 0) return 0;
  return titleTokens.filter((token) => haystack.has(token)).length;
}

// Decide which outstanding prompt a reply targets.
//  - 0 prompts            → { match: null, ambiguous: false } (no bridge)
//  - exactly 1 prompt     → resume it (the common case: a single waiting task)
//  - >1 prompts           → require an UNAMBIGUOUS title match; otherwise mark
//                           ambiguous so the caller asks "which one?" instead of
//                           guessing — this is what keeps concurrent tasks safe.
export function selectScheduledPromptForReply(prompts = [], text = '') {
  const list = Array.isArray(prompts) ? prompts.filter(Boolean) : [];
  if (list.length === 0) return { match: null, ambiguous: false };
  if (list.length === 1) return { match: list[0], ambiguous: false };

  const scored = list
    .map((prompt) => ({ prompt, score: titleMatchScore(text, prompt.title) }))
    .sort((left, right) => right.score - left.score);

  const top = scored[0];
  const second = scored[1];
  if (top.score > 0 && (!second || top.score > second.score)) {
    return { match: top.prompt, ambiguous: false };
  }
  return { match: null, ambiguous: true };
}

export default {
  listPendingScheduledPrompts,
  buildPendingScheduledPromptsMetadata,
  addPendingScheduledPrompt,
  removePendingScheduledPrompt,
  selectScheduledPromptForReply
};
