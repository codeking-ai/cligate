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
      requestedPath: String(normalized.input?.cwd || normalized.input?.workspaceRef || normalized.input?.workspaceId || '').trim(),
      input: (normalized.input && typeof normalized.input === 'object') ? normalized.input : {}
    };
  }
  return null;
}

// Human-readable labels for the tools that can hit the confirmation gate, so
// the user sees "I'm about to run a system command (higher risk)…" with the
// actual command/path — instead of the opaque `mutating_tool_requires_confirmation`
// code. Unknown tools fall back to a generic-but-named explanation.
const CONFIRMATION_TOOL_LABELS = {
  'zh-CN': {
    run_shell_command: { what: '执行一条系统命令', risk: '较高风险：可读写文件、调用系统程序' },
    write_file: { what: '写入文件', risk: '会改动磁盘上的文件内容' },
    edit_file: { what: '修改文件', risk: '会改动磁盘上的文件内容' },
    create_file: { what: '新建文件', risk: '会在磁盘上创建文件' },
    append_file: { what: '向文件追加内容', risk: '会改动磁盘上的文件内容' },
    delete_path: { what: '删除文件或目录', risk: '删除后通常不可恢复' },
    move_path: { what: '移动 / 重命名文件', risk: '会改动磁盘上的文件位置' },
    send_message_to_channel: { what: '向其它会话发送消息 / 图片', risk: '会把内容发到一个并非当前对话的会话' }
  },
  en: {
    run_shell_command: { what: 'run a system command', risk: 'higher risk: it can read/write files and invoke programs' },
    write_file: { what: 'write a file', risk: 'it changes file contents on disk' },
    edit_file: { what: 'edit a file', risk: 'it changes file contents on disk' },
    create_file: { what: 'create a file', risk: 'it creates a file on disk' },
    append_file: { what: 'append to a file', risk: 'it changes file contents on disk' },
    delete_path: { what: 'delete a file or directory', risk: 'deletion is usually irreversible' },
    move_path: { what: 'move / rename a file', risk: 'it changes where files live on disk' },
    send_message_to_channel: { what: 'send a message / image to another conversation', risk: 'it delivers to a conversation other than this one' }
  }
};

// Build a friendly, localized explanation of the action awaiting confirmation:
// what the tool does, why it is gated, the concrete args, and how to proceed /
// stop being asked.
function describeConfirmationAction(policyBlock = {}, language = 'en') {
  const zh = language === 'zh-CN';
  const toolName = String(policyBlock.toolName || '').trim();
  const input = policyBlock.input || {};
  const labels = CONFIRMATION_TOOL_LABELS[zh ? 'zh-CN' : 'en'] || {};
  const label = labels[toolName] || null;

  const command = String(input.command || '').trim();
  const filePath = String(
    input.path || input.file || input.filePath || input.targetPath || input.dest || ''
  ).trim();
  const cwd = String(input.cwd || policyBlock.requestedPath || '').trim();
  const target = String(input.targetConversationId || '').trim();
  const outsideWorkspace = String(policyBlock.reason || '').includes('path_outside_workspace');

  const what = label?.what || (zh ? `执行 ${toolName || '一个工具'}` : `run ${toolName || 'a tool'}`);
  const risk = label?.risk || (zh ? '会修改文件或系统状态' : 'it changes files or system state');

  const lines = [];
  lines.push(zh ? `我准备${what}（${risk}），需要你确认。` : `I'm about to ${what} (${risk}) — please confirm.`);
  if (command) lines.push(zh ? `命令：${truncate(command, 300)}` : `Command: ${truncate(command, 300)}`);
  if (filePath) lines.push(zh ? `目标文件：${filePath}` : `Target file: ${filePath}`);
  if (cwd && !filePath) lines.push(zh ? `目标/工作目录：${cwd}` : `Working directory: ${cwd}`);
  if (target) lines.push(zh ? `目标会话：${target}` : `Target conversation: ${target}`);
  if (outsideWorkspace && (cwd || filePath)) {
    lines.push(zh ? '（该路径在工作区之外，所以需要确认。）' : '(This path is outside the workspace, hence the confirmation.)');
  }
  lines.push(zh
    ? '回复「同意 / 确认」我就继续；如果不想本会话以后每一步都问，回复「全部同意」或发送 /yolo（之后用 /safe 可恢复逐次确认）。'
    : 'Reply "approve / yes" and I will continue. To stop being asked for the rest of this conversation, say "approve all" or send /yolo (use /safe to re-enable prompts).');
  return lines.join('\n');
}

function extractLlmFailureMessage(stopReason = '') {
  // Stop policy formats LLM failures as `assistant_llm_failed: <message>`. Pull
  // the message back out so the user-facing reply can show what actually broke
  // (timeout, no available supervisor tier, upstream 4xx) instead of a generic
  // "request handled" fallback.
  const text = String(stopReason || '');
  if (!text.startsWith('assistant_llm_failed')) return '';
  const idx = text.indexOf(':');
  return idx >= 0 ? text.slice(idx + 1).trim() : '';
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

  // Supervisor LLM hard-failed (all tiers errored / turn timed out). Surface
  // the concrete reason so the user can act, rather than letting the composer
  // fall through to "I have handled this request" — that silent-success path
  // was the original misleading symptom of the pptx-skill stall.
  if (finalStatus === 'failed' && extractLlmFailureMessage(stopReason)) {
    const detail = extractLlmFailureMessage(stopReason);
    if (language === 'zh-CN') {
      return {
        message: [
          '助手 LLM 这一轮失败了，没有进入工具执行阶段。',
          detail ? `失败原因：${truncate(detail, 240)}` : '',
          '你可以让我再试一次，或者把任务拆得更小一点。'
        ].filter(Boolean).join('\n\n'),
        summary: 'LLM 调用失败'
      };
    }
    return {
      message: [
        'The assistant LLM call failed before any tool ran.',
        detail ? `Reason: ${truncate(detail, 240)}` : '',
        'Ask me to retry or break the task into smaller steps.'
      ].filter(Boolean).join('\n\n'),
      summary: 'Assistant LLM call failed'
    };
  }
  if (stopReason === 'assistant_confirmation_required' && policyBlock) {
    // Explain WHAT needs confirming, WHY (risk), and HOW to proceed — instead of
    // surfacing the opaque `mutating_tool_requires_confirmation` reason code,
    // which left the user with no idea what they were approving.
    const description = describeConfirmationAction(policyBlock, language === 'zh-CN' ? 'zh-CN' : 'en');
    return {
      message: description,
      summary: language === 'zh-CN' ? '等待确认' : 'Waiting for confirmation'
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
