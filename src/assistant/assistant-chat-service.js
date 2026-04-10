import { resolveManualLanguage } from './language-service.js';
import { detectAssistantIntent } from './intent-service.js';
import { getManualContext } from './manual-service.js';
import { buildAssistantMessages } from './prompt-builder.js';

export function prepareAssistantRequest({ messages, uiLang } = {}) {
  const intent = detectAssistantIntent(messages);
  const language = resolveManualLanguage({ uiLang, messages });

  if (intent.type === 'general') {
    return {
      intent,
      language,
      messages,
      manualContext: null,
      citations: []
    };
  }

  const manualContext = getManualContext({
    language,
    query: intent.latestUserText
  });

  return {
    intent,
    language,
    manualContext,
    citations: manualContext.citations,
    messages: buildAssistantMessages(messages, {
      manualContext,
      language,
      intent
    })
  };
}

export default {
  prepareAssistantRequest
};
