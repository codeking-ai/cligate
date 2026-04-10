function countMatches(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

export function detectMessageLanguage(messages = [], fallback = 'en') {
  const text = Array.isArray(messages)
    ? messages
        .map((message) => typeof message?.content === 'string' ? message.content : '')
        .join('\n')
        .trim()
    : '';

  if (!text) return fallback;

  const cjkCount = countMatches(text, /[\u3400-\u9fff]/g);
  const latinCount = countMatches(text, /[A-Za-z]/g);

  if (cjkCount > 0 && (latinCount === 0 || cjkCount >= Math.max(4, latinCount / 3))) {
    return 'zh-CN';
  }

  if (latinCount > 0) {
    return 'en';
  }

  return fallback;
}

export function resolveManualLanguage({ uiLang, messages } = {}) {
  const normalizedUiLang = uiLang === 'zh' || uiLang === 'zh-CN'
    ? 'zh-CN'
    : 'en';
  const detected = detectMessageLanguage(messages, normalizedUiLang);
  return detected || normalizedUiLang;
}

export default {
  detectMessageLanguage,
  resolveManualLanguage
};
