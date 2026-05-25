import {
  getToolResultPendingCounts,
  isToolResultConfirmationRequired,
  normalizeAssistantToolResultEntry
} from './tool-result.js';

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

function collectPendingContext(toolResults = []) {
  for (const entry of [...toolResults].reverse()) {
    const normalized = normalizeAssistantToolResultEntry(entry);
    const result = normalized.payload;
    if (!result || typeof result !== 'object') continue;
    const title = String(result?.title || result?.session?.title || '').trim();
    const approvals = Array.isArray(result?.pendingApprovals) ? result.pendingApprovals : [];
    const questions = Array.isArray(result?.pendingQuestions) ? result.pendingQuestions : [];
    const pending = getToolResultPendingCounts(entry);
    if (approvals.length > 0 || pending.approvals > 0) {
      return {
        kind: 'approval',
        title,
        detail: String(approvals[0]?.title || approvals[0]?.summary || '').trim()
      };
    }
    if (questions.length > 0 || pending.questions > 0) {
      return {
        kind: 'question',
        title,
        detail: String(questions[0]?.text || '').trim()
      };
    }
  }
  return null;
}

function collectPolicyBlockContext(toolResults = []) {
  for (const entry of [...toolResults].reverse()) {
    const normalized = normalizeAssistantToolResultEntry(entry);
    const result = normalized.payload;
    if (!result || typeof result !== 'object') continue;
    if (!isToolResultConfirmationRequired(entry)) continue;
    return {
      toolName: normalized.toolName,
      summary: normalized.summary,
      hint: String(result?.hint || '').trim(),
      reason: String(result?.reason || '').trim(),
      requestedPath: String(normalized.input?.cwd || normalized.input?.workspaceRef || normalized.input?.workspaceId || '').trim()
    };
  }
  return null;
}

export function composeAssistantReply({
  language = 'en',
  assistantText = '',
  toolResults = [],
  finalStatus = 'completed',
  stopReason = ''
} = {}) {
  const text = String(assistantText || '').trim();
  const policyBlock = collectPolicyBlockContext(toolResults);
  if (stopReason === 'assistant_confirmation_required' && policyBlock) {
    if (language === 'zh-CN') {
      const detail = policyBlock.requestedPath
        ? `目标范围：${policyBlock.requestedPath}`
        : (policyBlock.summary || policyBlock.hint || '');
      return {
        message: [
          '这一步需要你确认后我才能继续。',
          detail ? `\n${detail}` : ''
        ].join(''),
        summary: '等待确认'
      };
    }
    const detail = policyBlock.requestedPath
      ? `Requested scope: ${policyBlock.requestedPath}`
      : (policyBlock.summary || policyBlock.hint || '');
    return {
      message: [
        'I need your confirmation before I can continue with this action.',
        detail ? `\n\n${detail}` : ''
      ].join(''),
      summary: 'Waiting for confirmation'
    };
  }

  if (text) {
    return {
      message: text,
      summary: firstSentence(text) || truncate(text, 160)
    };
  }

  // Iteration budget exhausted: the LLM kept making tool calls until the
  // ReAct loop hit maxIterations and never produced a final natural-language
  // reply. Tell the user that explicitly so they know to send "继续 / continue"
  // — falling back to the last tool's summary (the old behavior) made the
  // user think the work was done.
  if (stopReason === 'tool_phase_finished_without_assistant_summary') {
    const toolCount = toolResults.length;
    const lastSummary = [...toolResults]
      .reverse()
      .map((entry) => normalizeAssistantToolResultEntry(entry).summary || '')
      .find(Boolean) || '';
    if (language === 'zh-CN') {
      return {
        message: [
          `我已经连续调用了 ${toolCount} 次工具，但本轮的思考次数到上限了，还没来得及给你写一个总结回复。`,
          lastSummary ? `最近一步：${truncate(lastSummary, 160)}` : '',
          '请回复"继续"，我会接着把这一步推完。'
        ].filter(Boolean).join('\n\n'),
        summary: '迭代次数到达上限，等你继续'
      };
    }
    return {
      message: [
        `I chained ${toolCount} tool call${toolCount === 1 ? '' : 's'} this turn and hit the per-turn iteration budget before I could compose a final reply.`,
        lastSummary ? `Last step: ${truncate(lastSummary, 160)}` : '',
        'Reply "continue" and I will keep going from where I stopped.'
      ].filter(Boolean).join('\n\n'),
      summary: 'Iteration budget exhausted; awaiting continue'
    };
  }

  const latestSummary = [...toolResults]
    .reverse()
    .map((entry) => normalizeAssistantToolResultEntry(entry).summary || '')
    .find(Boolean);

  if (latestSummary) {
    return {
      message: String(latestSummary),
      summary: truncate(latestSummary, 160)
    };
  }

  if (language === 'zh-CN') {
    if (finalStatus === 'waiting_user') {
      const pending = collectPendingContext(toolResults);
      if (stopReason === 'runtime_waiting_approval') {
        return {
          message: pending?.detail
            ? `当前有一个任务在等待你的批准：${pending.detail}`
            : '当前有一个任务在等待你的批准，我收到你的决定后会继续推进。',
          summary: pending?.title
            ? `等待批准: ${truncate(pending.title, 120)}`
            : '等待批准'
        };
      }
      if (stopReason === 'runtime_waiting_user_input') {
        return {
          message: pending?.detail
            ? `当前有一个任务在等你回答：${pending.detail}`
            : '当前有一个任务在等你补充回答，我收到后会继续推进。',
          summary: pending?.title
            ? `等待回复: ${truncate(pending.title, 120)}`
            : '等待用户回复'
        };
      }
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
    const pending = collectPendingContext(toolResults);
    if (stopReason === 'runtime_waiting_approval') {
      return {
        message: pending?.detail
          ? `One task is waiting for your approval: ${pending.detail}`
          : 'One task is waiting for your approval before I can continue.',
        summary: pending?.title
          ? `Waiting for approval: ${truncate(pending.title, 120)}`
          : 'Waiting for approval'
      };
    }
    if (stopReason === 'runtime_waiting_user_input') {
      return {
        message: pending?.detail
          ? `One task is waiting for your answer: ${pending.detail}`
          : 'One task is waiting for your answer before I can continue.',
        summary: pending?.title
          ? `Waiting for user reply: ${truncate(pending.title, 120)}`
          : 'Waiting for user reply'
      };
    }
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
