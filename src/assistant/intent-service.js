const MANUAL_QA_PATTERNS = [
  /怎么用/,
  /怎么使用/,
  /如何使用/,
  /如何配置/,
  /怎么配置/,
  /使用说明/,
  /说明书/,
  /教程/,
  /步骤/,
  /guide/i,
  /how to/i,
  /how do i/i,
  /configure/i,
  /setup/i,
  /manual/i,
  /documentation/i
];

const TOOL_REQUEST_PATTERNS = [
  /帮我设置/,
  /帮我配置/,
  /帮我开启/,
  /帮我关闭/,
  /帮我取消/,
  /直接设置/,
  /直接配置/,
  /替我操作/,
  /现在执行/,
  /set it up for me/i,
  /configure it for me/i,
  /do it for me/i,
  /enable .*proxy/i,
  /disable .*proxy/i
];

function getLatestUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
      return message.content.trim();
    }
  }
  return '';
}

export function detectAssistantIntent(messages = []) {
  const latestUserText = getLatestUserText(messages);
  const actionName = detectRequestedAssistantAction(latestUserText);

  if (!latestUserText) {
    return { type: 'general', latestUserText, actionName: null };
  }

  if (actionName || TOOL_REQUEST_PATTERNS.some((pattern) => pattern.test(latestUserText))) {
    return { type: 'tool_request', latestUserText, actionName };
  }

  if (MANUAL_QA_PATTERNS.some((pattern) => pattern.test(latestUserText))) {
    return { type: 'manual_qa', latestUserText, actionName: null };
  }

  return { type: 'general', latestUserText, actionName: null };
}

export default {
  detectAssistantIntent
};
import { detectRequestedAssistantAction } from './tool-registry.js';
