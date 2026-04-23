function truncate(value, limit = 400) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function formatJson(value) {
  return JSON.stringify(value || {}, null, 2);
}

function buildSystemPrompt(language = 'en') {
  if (language === 'zh-CN') {
    return [
      '你是 CliGate Assistant。',
      '你是一个 LLM 驱动的 supervisor agent，负责理解用户目标、查看上下文、按需调用工具、按需委派 Codex 或 Claude Code 执行任务，并最终以自然语言回复用户。',
      '优先像一个人一样与用户协作，不要把内部工具调用过程直接当作最终回复。',
      '如果不需要工具和 runtime，就直接回答。',
      '如果需要查看状态或上下文，再调用只读工具。',
      '如需搜索现有任务或对话摘要，优先使用 search_task_and_conversation_memory；search_project_memory 只是兼容别名。',
      '如果需要真正执行任务，再委派 runtime。',
      '如果 runtime 已给出结果，要先理解并总结，再回复用户。',
      '尽量简洁、准确、直接，不编造不存在的状态或结果。',
      '不要输出内部 chain-of-thought，只输出结论、必要说明和下一步。'
    ].join(' ');
  }

  return [
    'You are CliGate Assistant.',
    'You are an LLM-driven supervisor agent that understands user goals, inspects context, calls tools when useful, delegates execution to Codex or Claude Code when necessary, and replies in natural language.',
    'Speak like a collaborative assistant, not like an internal task router.',
    'Answer directly when no tools or runtime work are needed.',
    'Use read-only tools when you need context.',
    'When searching existing task or conversation summaries, prefer search_task_and_conversation_memory; search_project_memory is only a deprecated compatibility alias.',
    'Delegate to runtime only when actual execution is needed.',
    'When runtime returns a result, summarize it for the user before replying.',
    'Be concise, accurate, and do not invent facts or state.',
    'Do not reveal chain-of-thought.'
  ].join(' ');
}

function buildContextBlock({
  conversation,
  taskRecord,
  conversationContext,
  workspaceContext,
  defaultRuntimeProvider,
  cwd,
  model
} = {}) {
  return [
    '<assistant_context>',
    `<conversation_id>${conversation?.id || ''}</conversation_id>`,
    `<assistant_mode>${conversation?.metadata?.assistantCore?.mode || 'direct-runtime'}</assistant_mode>`,
    `<default_runtime_provider>${defaultRuntimeProvider || 'codex'}</default_runtime_provider>`,
    `<workspace>${truncate(cwd || conversation?.metadata?.workspaceId || '', 200)}</workspace>`,
    `<runtime_model>${truncate(model || '', 120)}</runtime_model>`,
    '<current_task_record>',
    formatJson(taskRecord || null),
    '</current_task_record>',
    '<conversation_summary>',
    formatJson({
      conversation: conversationContext?.conversation || null,
      activeRuntime: conversationContext?.activeRuntime || null,
      latestTask: conversationContext?.latestTask || null,
      assistantState: conversationContext?.assistantState || null,
      memory: conversationContext?.memory || {},
      policy: conversationContext?.policy || {},
      recentDeliveries: Array.isArray(conversationContext?.deliveries)
        ? conversationContext.deliveries.slice(0, 6).map((entry) => ({
            direction: entry.direction,
            text: truncate(entry?.payload?.text || entry?.payload?.content || '', 200),
            createdAt: entry.createdAt
          }))
        : []
    }),
    '</conversation_summary>',
    '<workspace_summary>',
    formatJson(workspaceContext?.summary || {}),
    '</workspace_summary>',
    '</assistant_context>'
  ].join('\n');
}

export function buildInitialAnthropicMessages({
  language = 'en',
  conversation,
  text,
  taskRecord,
  conversationContext,
  workspaceContext,
  defaultRuntimeProvider = 'codex',
  cwd = '',
  model = ''
} = {}) {
  return {
    system: buildSystemPrompt(language),
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            buildContextBlock({
              conversation,
              taskRecord,
              conversationContext,
              workspaceContext,
              defaultRuntimeProvider,
              cwd,
              model
            }),
            '',
            '<user_request>',
            String(text || '').trim(),
            '</user_request>'
          ].join('\n')
        }
      ]
    }]
  };
}

export default {
  buildInitialAnthropicMessages
};
