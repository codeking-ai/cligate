function truncate(value, limit = 220) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function firstSentence(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  const match = source.match(/^(.+?[。.!?！？])(?:\s|$)/);
  return truncate(match ? match[1] : source, 160);
}

export function composeAssistantReply({
  language = 'en',
  assistantText = '',
  toolResults = [],
  finalStatus = 'completed'
} = {}) {
  const text = String(assistantText || '').trim();
  if (text) {
    return {
      message: text,
      summary: firstSentence(text) || truncate(text, 160)
    };
  }

  const latestSummary = [...toolResults]
    .reverse()
    .map((entry) => entry?.summary || entry?.result?.summary || '')
    .find(Boolean);

  if (latestSummary) {
    return {
      message: String(latestSummary),
      summary: truncate(latestSummary, 160)
    };
  }

  if (language === 'zh-CN') {
    if (finalStatus === 'waiting_user') {
      return {
        message: '我已经推进到需要你回应的步骤，等你回复后我会继续。',
        summary: '等待用户回应'
      };
    }
    if (finalStatus === 'waiting_runtime') {
      return {
        message: '我已经开始推进这个任务，后台完成后会继续汇总结果。',
        summary: '后台执行中'
      };
    }
    return {
      message: '我已经处理完这次请求。',
      summary: '请求已处理'
    };
  }

  if (finalStatus === 'waiting_user') {
    return {
      message: 'I have moved this forward and now I need your reply before I can continue.',
      summary: 'Waiting for user input'
    };
  }
  if (finalStatus === 'waiting_runtime') {
    return {
      message: 'I have started the work and will continue once the runtime progresses.',
      summary: 'Running in background'
    };
  }
  return {
    message: 'I have handled this request.',
    summary: 'Request handled'
  };
}

export default {
  composeAssistantReply
};
