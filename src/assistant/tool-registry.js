function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

const ENABLE_PATTERNS = [
  /帮我设置.*claude/i,
  /帮我配置.*claude/i,
  /帮我开启.*代理/i,
  /设置.*claude code.*代理/i,
  /配置.*claude code.*代理/i,
  /enable.*claude code.*proxy/i,
  /set up.*claude code.*proxy/i,
  /configure.*claude code.*proxy/i
];

const DISABLE_PATTERNS = [
  /帮我取消.*claude/i,
  /帮我关闭.*代理/i,
  /取消.*claude code.*代理/i,
  /关闭.*claude code.*代理/i,
  /disable.*claude code.*proxy/i,
  /remove.*claude code.*proxy/i,
  /turn off.*claude code.*proxy/i
];

export function detectRequestedAssistantAction(latestUserText) {
  const text = normalizeText(latestUserText);
  if (!text) return null;

  if (DISABLE_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'disable_claude_code_proxy';
  }

  if (ENABLE_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'enable_claude_code_proxy';
  }

  return null;
}

export default {
  detectRequestedAssistantAction
};
