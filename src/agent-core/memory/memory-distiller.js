import assistantMemoryStore from './memory-store.js';
import { matchMemories } from './keyword-match.js';
import assistantLlmClient from '../../assistant-agent/llm-client.js';
import { DESKTOP_INPUT_TOOLS } from '../../assistant-core/run-resource-registry.js';
import { getServerSettings } from '../../server-settings.js';
import { redactSecrets } from '../../utils/redact-secrets.js';

// Auto-formation: after a task SUCCEEDS, distill its run into a reusable memory
// (Phase B of the self-evolution design). Runs best-effort and fire-and-forget
// — it must never block or break the reply. The "verify-then-trust" write-back
// is implicit: a later corrected success with the same signature re-distills and
// merges in place (越用越准), preserving prior gotchas via the priorMemory hint.

const MIN_PROCEDURAL_STEPS = 2;
const DISTILL_MAX_TOKENS = 1500;

// Non-desktop tools that count as "real procedural work" worth remembering.
const PROCEDURAL_TOOLS = new Set([
  'continue_task',
  'send_runtime_input',
  'write_file',
  'edit_file',
  'run_shell_command',
  'start_runtime_task',
  'delegate_task_execution'
]);

function autoFormEnabled() {
  // Best-effort settings read; default ON. Never let a settings hiccup decide.
  // Disable with settings.assistant.memory.autoFormEnabled === false.
  try {
    const value = getServerSettings()?.assistant?.memory?.autoFormEnabled;
    return value === undefined ? true : value !== false;
  } catch {
    return true;
  }
}

function truncate(value, n) {
  const s = String(value || '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function isProceduralTool(tool) {
  const name = String(tool || '');
  return DESKTOP_INPUT_TOOLS.has(name) || PROCEDURAL_TOOLS.has(name) || name.startsWith('delegate_');
}

function summarizeSteps(run) {
  const results = Array.isArray(run?.metadata?.toolResults) ? run.metadata.toolResults : [];
  return results.map((r, i) => ({
    n: i + 1,
    tool: String(r?.toolName || ''),
    status: String(r?.status || ''),
    // Redact credentials before this ever reaches the distilling LLM (e.g. a
    // password typed via desktop_type_text shows up in the tool input).
    detail: redactSecrets(truncate(String(r?.summary || '') || (() => {
      try { return JSON.stringify(r?.input ?? {}); } catch { return ''; }
    })(), 200))
  }));
}

function parseJsonLoose(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = [
  '你是 CliGate Assistant 的"记忆蒸馏器"。一个任务刚刚成功完成。请判断它是否值得记成"以后能复用的记忆"，值得就蒸馏成一条结构化记忆。',
  '只输出**严格的 JSON 对象**，不要任何额外文字或解释，字段如下：',
  '{',
  '  "shouldRemember": true/false,   // 一次性 / 琐碎 / 不可复用 → false',
  '  "kind": "procedure|fact|directive|reference",',
  '  "title": "一句话标题",',
  '  "topic": "站点/应用/项目/主题；没有就空串",',
  '  "keywords": ["含同义词别名，便于以后关键词召回"],',
  '  "recall": "on-match",           // 几乎总是 on-match',
  '  "confidence": "high|medium|low",',
  '  "body": "markdown：procedure 写【当前最优步骤】(具体到用了哪个工具/控件/按钮) + 【坑/注意】；其它类型写清内容"',
  '}',
  '规则：只记可复用的"怎么做/事实/规矩"；**绝不写入任何密码、密钥、token**；步骤要具体可照做；',
  '若给了【已有同类记忆】，请在其基础上精修合并（保留仍然有效的坑），而不是从头重写。'
].join('\n');

export async function maybeFormFromRun({
  run,
  conversation = null, // reserved for future scoping
  runText = '',
  store = assistantMemoryStore,
  llmClient = assistantLlmClient
} = {}) {
  try {
    if (!autoFormEnabled()) return { formed: false, reason: 'disabled' };
    if (!run || String(run.status || '').trim() !== 'completed') {
      return { formed: false, reason: 'not_completed' };
    }

    const steps = summarizeSteps(run);
    const proceduralCount = steps.filter((s) => isProceduralTool(s.tool)).length;
    if (proceduralCount < MIN_PROCEDURAL_STEPS) {
      return { formed: false, reason: 'not_procedural' };
    }

    const hasSource = await llmClient?.hasAvailableSource?.();
    if (!hasSource) return { formed: false, reason: 'no_llm_source' };

    const goal = String(runText || run.triggerText || '').trim();
    let priorBody = '';
    let priorTitle = '';
    try {
      const prior = matchMemories(goal, store.catalog(), { limit: 1 })[0] || null;
      if (prior) {
        priorTitle = prior.title;
        priorBody = store.get(prior.id)?.body || '';
      }
    } catch {
      /* prior lookup is a nicety; ignore failures */
    }

    const payload = [
      `【任务目标】\n${goal || '(未提供)'}`,
      `【执行步骤（按序）】\n${steps.map((s) => `${s.n}. ${s.tool} [${s.status}] ${s.detail}`).join('\n')}`,
      `【结果】\n${truncate(String(run.summary || run.result || ''), 400)}`,
      priorTitle ? `【已有同类记忆（请在其基础上精修合并）】\n标题：${priorTitle}\n正文：\n${truncate(priorBody, 1200)}` : '',
      '请输出严格 JSON。'
    ].filter(Boolean).join('\n\n');

    const completion = await llmClient.complete({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: payload }] }],
      tools: [],
      model: '',
      maxTokens: DISTILL_MAX_TOKENS
    });

    const parsed = parseJsonLoose(completion?.text);
    if (!parsed || parsed.shouldRemember === false) {
      return { formed: false, reason: 'llm_declined' };
    }
    const title = String(parsed.title || '').trim();
    const body = String(parsed.body || '').trim();
    if (!title || !body) return { formed: false, reason: 'incomplete' };

    const saved = store.upsert({
      title,
      kind: parsed.kind,
      recall: parsed.recall,
      topic: parsed.topic,
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      confidence: parsed.confidence,
      body,
      source: 'auto',
      verified: true,
      scope: 'global'
    });
    return { formed: true, id: saved.id, title: saved.title };
  } catch {
    return { formed: false, reason: 'error' };
  }
}

export default maybeFormFromRun;
