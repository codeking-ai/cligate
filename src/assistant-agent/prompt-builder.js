import { renderAvailableSkills, renderActiveSkills } from '../skills/renderer.js';

function truncate(value, limit = 400) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function formatJson(value) {
  return JSON.stringify(value || {}, null, 2);
}

function formatOptionalBlock(value = '') {
  const text = String(value || '').trim();
  return text ? [text] : [];
}

function collectReplayImageParts({
  inputParts = null,
  conversationContext = null,
  limit = 2
} = {}) {
  const currentTurnImages = Array.isArray(inputParts)
    ? inputParts.filter((part) => part?.type === 'input_image' && String(part.image_url || part.url || '').trim())
    : [];
  if (currentTurnImages.length > 0) {
    return [];
  }
  const artifacts = Array.isArray(conversationContext?.relevantArtifacts) && conversationContext.relevantArtifacts.length > 0
    ? conversationContext.relevantArtifacts
    : (Array.isArray(conversationContext?.recentToolArtifacts)
      ? conversationContext.recentToolArtifacts
      : [])
  return artifacts
    .filter((entry) => (
      String(entry?.imageUrl || '').trim()
    ))
    .slice(0, Math.max(1, limit))
    .map((entry) => ({
      type: 'input_image',
      image_url: String(entry.imageUrl || '').trim(),
      ...(String(entry.mediaType || '').trim() ? { media_type: String(entry.mediaType || '').trim() } : {})
    }));
}

function buildAnthropicImagePart(part = {}) {
  const imageUrl = String(part.image_url || part.url || '').trim();
  if (!imageUrl) return null;
  return {
    type: 'image',
    source: imageUrl.startsWith('data:')
      ? {
          type: 'base64',
          media_type: String(part.media_type || '').trim() || (imageUrl.match(/^data:([^;]+);base64,/i)?.[1] || 'image/jpeg'),
          data: imageUrl.replace(/^data:[^;]+;base64,/i, '')
        }
      : {
          type: 'url',
          url: imageUrl,
          ...(String(part.media_type || '').trim()
            ? { media_type: String(part.media_type || '').trim() }
            : {})
        }
  };
}

function getAssistantControlMode(conversation = null) {
  return String(
    conversation?.metadata?.assistantCore?.controlMode
    || conversation?.metadata?.assistantCore?.mode
    || 'direct-runtime'
  ).trim() || 'direct-runtime';
}

function summarizePendingApprovals(conversationContext = null) {
  const activeRuntime = conversationContext?.activeRuntime || null;
  const pendingApprovals = Array.isArray(conversationContext?.pendingApprovals)
    ? conversationContext.pendingApprovals
    : [];
  return {
    activeRuntimeSessionId: String(activeRuntime?.id || '').trim(),
    activeRuntimeProvider: String(activeRuntime?.provider || '').trim(),
    count: pendingApprovals.length,
    items: pendingApprovals.slice(0, 5).map((entry) => ({
      approvalId: String(entry?.approvalId || '').trim(),
      sessionId: String(entry?.sessionId || '').trim(),
      title: String(entry?.title || '').trim(),
      summary: String(entry?.summary || '').trim(),
      createdAt: String(entry?.createdAt || '').trim()
    }))
  };
}

function summarizePendingQuestions(conversationContext = null) {
  const activeRuntime = conversationContext?.activeRuntime || null;
  const pendingQuestions = Array.isArray(conversationContext?.pendingQuestions)
    ? conversationContext.pendingQuestions
    : [];
  return {
    activeRuntimeSessionId: String(activeRuntime?.id || '').trim(),
    activeRuntimeProvider: String(activeRuntime?.provider || '').trim(),
    count: pendingQuestions.length,
    items: pendingQuestions.slice(0, 5).map((entry) => ({
      questionId: String(entry?.questionId || '').trim(),
      sessionId: String(entry?.sessionId || '').trim(),
      text: String(entry?.text || '').trim(),
      options: Array.isArray(entry?.options) ? entry.options : [],
      createdAt: String(entry?.createdAt || '').trim()
    }))
  };
}

function summarizePendingClarification(conversationContext = null) {
  const clarification = conversationContext?.pendingClarification || null;
  if (!clarification || typeof clarification !== 'object') {
    return null;
  }
  return {
    clarificationId: String(clarification?.id || '').trim(),
    question: String(clarification?.question || '').trim(),
    askedAt: String(clarification?.askedAt || '').trim(),
    ttlSec: Number(clarification?.ttlSec || 0),
    candidates: Array.isArray(clarification?.candidates)
      ? clarification.candidates.slice(0, 8).map((entry) => ({
          kind: String(entry?.kind || '').trim(),
          id: String(entry?.id || '').trim(),
          label: String(entry?.label || '').trim(),
          ...(Number.isFinite(Number(entry?.confidence)) ? { confidence: Number(entry.confidence) } : {})
        }))
      : []
  };
}

function summarizePendingAssistantConfirmation(conversationContext = null) {
  const pending = conversationContext?.pendingAssistantConfirmation || null;
  if (!pending || typeof pending !== 'object') {
    return null;
  }
  return {
    confirmToken: String(pending?.confirmToken || '').trim(),
    assistantRunId: String(pending?.assistantRunId || '').trim(),
    toolName: String(pending?.toolName || '').trim(),
    title: String(pending?.title || '').trim(),
    summary: String(pending?.summary || '').trim(),
    input: pending?.input && typeof pending.input === 'object' ? pending.input : {},
    metadata: pending?.metadata && typeof pending.metadata === 'object' ? pending.metadata : {},
    expiresAt: Number(pending?.expiresAt || 0)
  };
}

function computeStaleSinceHours(updatedAt) {
  const ts = Date.parse(String(updatedAt || ''));
  if (!Number.isFinite(ts)) return null;
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 0;
  return Math.round((diffMs / (60 * 60 * 1000)) * 10) / 10;
}

function summarizeTaskRecord(task = null) {
  if (!task?.taskId && !task?.id) return null;
  // 这两个字段告诉 LLM "这个 task 上一轮 codex 实际在干什么"，
  // 用于路由决策时判断"用户当前消息是不是这个 task 的自然延续"
  const lastTurnInput = task?.latestTurn?.input || '';
  const lastTurnSummary = task?.latestTurn?.summary
    || task?.summary
    || task?.runtimeSession?.summary
    || '';
  const updatedAt = task.updatedAt || task?.latestTurn?.updatedAt || '';
  return {
    taskId: task.taskId || task.id || '',
    conversationId: task.conversationId || task?.conversation?.id || '',
    title: task?.task?.title || task.title || '',
    assistantProjectId: task?.assistantDomain?.project?.id || '',
    assistantProjectName: task?.assistantDomain?.project?.name || '',
    assistantProjectKind: task?.assistantDomain?.project?.kind || '',
    assistantExecutionId: task?.assistantDomain?.execution?.id || '',
    assistantExecutionStatus: task?.assistantDomain?.execution?.status || '',
    assistantExecutionRole: task?.assistantDomain?.execution?.role || '',
    assistantExecutionRuntimeSessionId: task?.assistantDomain?.execution?.currentRuntimeSessionId || '',
    state: task.state || task?.task?.status || '',
    waitingReason: task.waitingReason || '',
    summary: task.summary || '',
    resultPreview: truncate(task.resultPreview || '', 200),
    provider: task?.runtimeSession?.provider || task?.task?.provider || '',
    runtimeSessionId: task?.runtimeSession?.id || task?.task?.runtimeSessionId || '',
    primaryExecutionId: task?.task?.primaryExecutionId || task?.task?.runtimeSessionId || '',
    latestExecutionId: task?.task?.latestExecutionId || task?.runtimeSession?.id || task?.task?.runtimeSessionId || '',
    originKind: task?.task?.originKind || '',
    sourceTaskId: task?.task?.sourceTaskId || '',
    cwd: task?.task?.cwd || '',
    cwdBasename: task?.task?.cwdBasename || '',
    lastConversationId: task?.task?.lastConversationId || task.conversationId || task?.conversation?.id || '',
    lastTurnInput: truncate(lastTurnInput, 80),
    lastTurnSummary: truncate(lastTurnSummary, 200),
    staleSinceHours: computeStaleSinceHours(updatedAt),
    pending: task?.pending || { approvalCount: 0, questionCount: 0 },
    assistantDomain: task?.assistantDomain || null,
    updatedAt
  };
}

function summarizeKnownCwd(entry = null) {
  const workspaceRef = String(entry?.workspaceRef || '').trim();
  if (!workspaceRef) return null;
  return {
    workspaceId: String(entry?.id || '').trim(),
    workspaceRef,
    name: String(entry?.name || '').trim(),
    defaultRuntimeProvider: String(entry?.defaultRuntimeProvider || '').trim(),
    aliases: Array.isArray(entry?.aliases) ? entry.aliases.slice(0, 8) : [],
    summary: String(entry?.summary || '').trim(),
    taskIds: Array.isArray(entry?.taskIds) ? entry.taskIds.slice(0, 8) : [],
    openTaskIds: Array.isArray(entry?.openTaskIds) ? entry.openTaskIds.slice(0, 8) : [],
    lastTouchedAt: String(entry?.lastTouchedAt || '').trim()
  };
}

function summarizeReferenceResolution(referenceResolution = null) {
  return {
    intent: String(referenceResolution?.intent || '').trim(),
    summary: {
      referenceCount: Number(referenceResolution?.summary?.referenceCount || 0),
      primaryPhrase: String(referenceResolution?.summary?.primaryPhrase || '').trim(),
      confidence: String(referenceResolution?.summary?.confidence || '').trim(),
      recommendedAction: String(referenceResolution?.summary?.recommendedAction || '').trim(),
      preferredTaskId: String(referenceResolution?.summary?.preferredTaskId || '').trim(),
      preferredWorkspaceRef: String(referenceResolution?.summary?.preferredWorkspaceRef || '').trim(),
      shouldAskUser: referenceResolution?.summary?.shouldAskUser === true
    },
    references: Array.isArray(referenceResolution?.references)
      ? referenceResolution.references.slice(0, 4).map((entry) => ({
          phrase: String(entry?.phrase || '').trim(),
          ambiguous: entry?.ambiguous === true,
          confidence: String(entry?.confidence || '').trim(),
          recommendedAction: String(entry?.recommendedAction || '').trim(),
          preferredTaskId: String(entry?.preferredTaskId || '').trim(),
          preferredWorkspaceRef: String(entry?.preferredWorkspaceRef || '').trim(),
          shouldAskUser: entry?.shouldAskUser === true,
          topCandidates: Array.isArray(entry?.topCandidates)
            ? entry.topCandidates.slice(0, 5).map((candidate) => ({
                kind: String(candidate?.kind || '').trim(),
                id: String(candidate?.id || '').trim(),
                label: String(candidate?.label || '').trim(),
                score: Number(candidate?.score || 0),
                ...(candidate?.conversationId ? { conversationId: String(candidate.conversationId).trim() } : {}),
                ...(typeof candidate?.isCurrentConversation === 'boolean'
                  ? { isCurrentConversation: candidate.isCurrentConversation }
                  : {})
              }))
            : []
        }))
      : []
  };
}

function summarizeRecentIntentTimeline(timeline = []) {
  return Array.isArray(timeline)
    ? timeline.slice(0, 8).map((entry) => ({
        ts: String(entry?.ts || '').trim(),
        userText: truncate(entry?.userText || '', 160),
        action: String(entry?.action || '').trim(),
        resolvedTargetTaskId: String(entry?.resolvedTargetTaskId || '').trim(),
        resolvedTargetCwd: String(entry?.resolvedTargetCwd || '').trim(),
        referenceConfidence: String(entry?.referenceConfidence || '').trim(),
        resolutionAction: String(entry?.resolutionAction || '').trim(),
        shouldAskUser: entry?.shouldAskUser === true
      }))
    : [];
}

function summarizeTaskWorkingMemory(taskRecord = null) {
  const workingMemory = taskRecord?.assistantDomain?.task?.workingMemory
    || taskRecord?.task?.workingMemory
    || null;
  if (!workingMemory || typeof workingMemory !== 'object') {
    return null;
  }
  return {
    objective: String(workingMemory.objective || '').trim(),
    currentPlan: truncate(workingMemory.currentPlan || '', 240),
    lastMeaningfulProgress: truncate(workingMemory.lastMeaningfulProgress || '', 240),
    nextAction: String(workingMemory.nextAction || '').trim(),
    artifactRefs: Array.isArray(workingMemory.artifactRefs) ? workingMemory.artifactRefs.slice(0, 12) : [],
    lastUpdatedAt: String(workingMemory.lastUpdatedAt || '').trim()
  };
}

function summarizeRecentChatTurns(turns = []) {
  return Array.isArray(turns)
    ? turns.slice(-8).map((entry) => ({
        role: String(entry?.role || '').trim(),
        text: truncate(entry?.text || '', 240),
        parts: Array.isArray(entry?.parts)
          ? entry.parts.slice(0, 3).map((part) => summarizeRecentChatTurnPart(part)).filter(Boolean)
          : [],
        kind: String(entry?.kind || '').trim(),
        sourceType: String(entry?.sourceType || '').trim(),
        assistantRunId: String(entry?.assistantRunId || '').trim(),
        runStatus: String(entry?.runStatus || '').trim(),
        sessionId: String(entry?.sessionId || '').trim(),
        createdAt: String(entry?.createdAt || '').trim()
      }))
    : [];
}

function summarizeRecentChatTurnPart(part = {}) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text') {
    const text = String(part.text || '').trim();
    if (!text) return null;
    return {
      type: 'text',
      text: truncate(text, 120)
    };
  }
  if (part.type === 'input_image') {
    const imageUrl = String(part.image_url || '').trim();
    if (!imageUrl) return null;
    return {
      type: 'input_image',
      mediaType: String(part.media_type || '').trim()
        || (imageUrl.match(/^data:([^;]+);base64,/i)?.[1] || ''),
      imageUrlPreview: imageUrl.startsWith('data:')
        ? `${imageUrl.slice(0, 48)}...`
        : truncate(imageUrl, 120)
    };
  }
  return null;
}

function summarizeRecentToolArtifacts(artifacts = []) {
  return Array.isArray(artifacts)
    ? artifacts.slice(0, 8).map((entry) => ({
        kind: String(entry?.kind || '').trim(),
        role: String(entry?.role || '').trim(),
        path: String(entry?.path || '').trim(),
        command: String(entry?.command || '').trim(),
        cwd: String(entry?.cwd || '').trim(),
        mediaType: String(entry?.mediaType || '').trim(),
        imageUrlPreview: String(entry?.imageUrl || '').trim()
          ? (String(entry.imageUrl).startsWith('data:')
            ? `${String(entry.imageUrl).slice(0, 48)}...`
            : truncate(String(entry.imageUrl), 120))
          : '',
        size: Number.isFinite(Number(entry?.size)) ? Number(entry.size) : null,
        detail: String(entry?.detail || '').trim(),
        mode: String(entry?.mode || '').trim(),
        success: typeof entry?.success === 'boolean' ? entry.success : undefined,
        preview: truncate(entry?.preview || '', 240),
        stdoutPreview: truncate(entry?.stdoutPreview || '', 240),
        stderrPreview: truncate(entry?.stderrPreview || '', 240),
        startLine: Number.isFinite(Number(entry?.startLine)) ? Number(entry.startLine) : null,
        endLine: Number.isFinite(Number(entry?.endLine)) ? Number(entry.endLine) : null,
        updatedAt: String(entry?.updatedAt || '').trim()
      }))
    : [];
}

function summarizeRelevantArtifacts(artifacts = []) {
  return Array.isArray(artifacts)
    ? artifacts.slice(0, 8).map((entry) => ({
        id: String(entry?.id || '').trim(),
        kind: String(entry?.kind || '').trim(),
        source: String(entry?.source || '').trim(),
        role: String(entry?.role || '').trim(),
        title: truncate(entry?.title || '', 120),
        summary: truncate(entry?.summary || '', 200),
        mediaType: String(entry?.mediaType || '').trim(),
        path: String(entry?.path || '').trim(),
        imageUrlPreview: String(entry?.imageUrl || '').trim()
          ? (String(entry.imageUrl).startsWith('data:')
            ? `${String(entry.imageUrl).slice(0, 48)}...`
            : truncate(String(entry.imageUrl), 120))
          : '',
        taskId: String(entry?.taskId || '').trim(),
        projectId: String(entry?.projectId || '').trim(),
        updatedAt: String(entry?.updatedAt || '').trim()
      }))
    : [];
}

function summarizeUserProfile(memory = null) {
  const profile = memory?.userProfile || null;
  if (!profile || typeof profile !== 'object') {
    return null;
  }
  return {
    replyLanguage: String(profile?.replyLanguage || '').trim(),
    responseStyle: String(profile?.responseStyle || '').trim(),
    preferredRuntimeProvider: String(profile?.preferredRuntimeProvider || '').trim(),
    executionStyle: String(profile?.executionStyle || '').trim()
  };
}

function isStatusLikeRequest(text = '') {
  const source = String(text || '').trim();
  if (!source) return false;
  return [
    /^(status|progress|update)\b/i,
    /\b(what('| i)?s the status|how('| i)?s it going|progress update|current status)\b/i,
    /(进展如何|现在进度|现在怎么样|情况如何|状态如何|当前状态|现在什么情况|进展怎么样|目前怎么样)/
  ].some((pattern) => pattern.test(source));
}

function isContinueLikeRequest(text = '') {
  const source = String(text || '').trim();
  if (!source) return false;
  return [
    /^(continue|resume|follow up|keep going)\b/i,
    /(继续刚才那个|继续这个|接着做|接着改|继续处理|继续推进|把刚才那个继续|继续一下)/
  ].some((pattern) => pattern.test(source));
}

function isRetryLikeRequest(text = '') {
  const source = String(text || '').trim();
  if (!source) return false;
  return [
    /^(重试|再试一次|重新试|retry|try again)/i,
    /(重试刚才那个|重试这个|retry this|retry that)/i
  ].some((pattern) => pattern.test(source));
}

function isRelatedTaskLikeRequest(text = '') {
  const source = String(text || '').trim();
  if (!source) return false;
  return [
    /(另外再做一个|基于刚才那个再做一个|相关任务|再做一个|再来一个)/,
    /\b(another one|related task|sibling task|based on that create another)\b/i
  ].some((pattern) => pattern.test(source));
}

function isReturnToSourceLikeRequest(text = '') {
  const source = String(text || '').trim();
  if (!source) return false;
  return [
    /(回到上一个任务|回到原任务|回到刚才那个任务|回到原来的任务)/,
    /\b(return to (the )?(previous|source|original) task)\b/i
  ].some((pattern) => pattern.test(source));
}

function buildRoutingHints({ text = '', taskSpace = null, referenceResolution = null } = {}) {
  const decisionHints = taskSpace?.decisionHints || {};
  const referenceSummary = referenceResolution?.summary || {};
  let requestType = 'freeform_request';

  if (isStatusLikeRequest(text)) {
    requestType = 'status_query';
  } else if (isRetryLikeRequest(text)) {
    requestType = 'retry_task';
  } else if (isReturnToSourceLikeRequest(text)) {
    requestType = 'return_to_source';
  } else if (isRelatedTaskLikeRequest(text)) {
    requestType = 'related_sibling';
  } else if (isContinueLikeRequest(text)) {
    requestType = 'continue_task';
  }

  return {
    requestType,
    shouldClarify: Boolean(decisionHints.shouldClarify),
    preferredAction: String(decisionHints.preferredAction || ''),
    preferredTaskId: String(decisionHints.preferredTaskId || ''),
    preferredExecutionTarget: String(
      decisionHints?.focusTaskExecutionContinuity?.preferredRuntimeSessionId
      || decisionHints.focusTaskExecutionTarget
      || ''
    ),
    preferredAssistantExecutionId: String(
      decisionHints?.focusTaskExecutionContinuity?.preferredAssistantExecutionId
      || ''
    ),
    preferredExecutionSource: String(
      decisionHints?.focusTaskExecutionContinuity?.source
      || ''
    ),
    canContinuePreferredExecution: decisionHints?.focusTaskExecutionContinuity?.canContinue === true,
    preferredReferenceAction: String(referenceSummary.recommendedAction || ''),
    preferredReferenceTaskId: String(referenceSummary.preferredTaskId || ''),
    preferredReferenceWorkspaceRef: String(referenceSummary.preferredWorkspaceRef || ''),
    referenceConfidence: String(referenceSummary.confidence || ''),
    shouldClarifyFromReference: referenceSummary.shouldAskUser === true,
    reason: String(decisionHints.reason || ''),
    shouldPreferStatusOverview: Boolean(decisionHints.shouldPreferStatusOverview),
    shouldPreferWaitingTask: Boolean(decisionHints.shouldPreferWaitingTask),
    shouldReuseFocusTask: Boolean(decisionHints.shouldReuseFocusTask)
  };
}

function buildSystemPrompt(language = 'en') {
  if (language === 'zh-CN') {
    return [
      '你是 CliGate Assistant。',
      '你是一个 LLM 驱动的 supervisor agent，负责理解用户目标、查看上下文、按需调用工具、按需委派 Codex 或 Claude Code 执行任务，并最终以自然语言回复用户。',
      '如果当前请求明显匹配某个 available skill 的用途，你应主动使用该 skill，而不是等待用户显式点名。skill 一旦在本 run 内激活，后续步骤继续遵守它。',
      '如果当前请求已经切换到另一类工作，而新的 skill 更匹配，就应替换旧的 active skill，而不是把不相关的旧 skill 一直带着。',
      'skill 执行纪律（极其重要）：当 <active_skills> 中有 skill 时，**必须由你自己用本地工具按 SKILL.md 的步骤执行**（read_file / write_file / replace_in_file / run_shell_command / view_image / list_directory / MCP tools）。SKILL.md 里的 `python -m markitdown`、`npm install`、`pdftoppm`、`soffice`、Read/Write 这些命令是写给"宿主 agent（你）"的指令，**不是要你把它塞进 task 让 codex/claude-code 去跑**。**严禁**为了"让 codex/claude-code 帮我跑 skill"而调用 delegate_to_codex / delegate_to_claude_code / delegate_to_runtime / start_runtime_task / continue_task / send_runtime_input —— 下游 runtime **不会加载 SKILL.md，更看不到 editing.md / pptxgenjs.md 等子文件**，委派出去等于让对方瞎猜，是对 skill 系统的破坏。只有当用户**明确说**"用 codex / 用 claude code 跑"，或者你**已经亲自尝试了本地执行并拿到了具体的环境错误**（必须把错误如实写在回复里），才考虑委派。',
      '自动同意模式（auto_approve_tools）：<assistant_context> 里的 <auto_approve_tools> 标签反映用户是否开启了 yolo / 自动同意模式。**当它是 on 时**：(1) 所有 mutating 工具（write_file / replace_in_file / run_shell_command 等）会被系统自动放行，不会再返回 requires_approval / policy_block，你只管按计划一次性把工具调下去；(2) **严禁**再向用户询问"是否同意/允许吗/确认吗"这类确认句式，也不要再生成 pending_assistant_confirmation —— 用户已经开了 yolo 就是明确表达"不要再问"；(3) 只有当工具实际执行抛出**非授权类**错误（找不到二进制、网络错误、文件不存在等）时，才把错误如实回报给用户。**当它是 off 时**：保持原有的逐项确认行为。用户可以随时通过 /yolo 打开、/safe 关闭，也可以用"同意后续所有操作 / 本次对话都允许 / 不要再问"等自然语言开启。',
      '优先像一个人一样与用户协作，不要把内部工具调用过程直接当作最终回复。',
      '如果不需要工具和 runtime，就直接回答。',
      '如果需要查看状态或上下文，再调用只读工具。',
      '当前对话上下文以 task space 为中心，不要默认把 active runtime 当作唯一主线。',
      '特别注意 task 的 originKind、sourceTaskId、primaryExecutionId、latestExecutionId，这些字段用于理解当前 task 是重试、回到源任务、相关 sibling task，还是普通延续。',
      '如果上下文里同时给出了 assistantProjectId / assistantProjectName / assistantExecutionId / assistantExecutionStatus / assistantExecutionRole，优先按 Project/Task/Execution 语义理解，而不是把 conversation 或 runtime session 当作唯一真相源。',
      '先看 focus task、waiting tasks、active tasks，再决定是直接回答、观察、继续某个 task、发起新委派，还是先澄清。',
      '如果 task_space 里有 decisionHints，优先遵循 preferredAction、preferredTaskId、reason，再结合 focusTaskReason 和 taskRelationshipSummary 判断。',
      '如果上下文里有 routingHints，优先把它当作当前用户请求的意图线索；尤其注意 requestType、shouldClarify、preferredTaskId、preferredExecutionTarget。',
      '如果 reference_resolution.summary 给出了 high/medium confidence 的 preferred task 或 workspace，优先把它作为引用理解的主要线索；如果 shouldAskUser 为 true，就不要猜。',
      'assistant mode 下没有任何 pre-LLM 的 pending 硬路由。即使存在 runtime approval 或 runtime question，也必须由你结合用户这条消息显式判断。',
      '如果上下文出现 pending_runtime_approval，并且用户是在批准或拒绝该请求，调用 resolve_runtime_approval；不要假设系统会自动批准。remember 参数的取值要严格按用户语义判定：(a) 用户只说"同意 / 可以 / 这次允许 / 这一次"——没有提到以后/本会话/记住——按一次性处理，remember 留空（默认 none）。(b) 用户说"本会话 / 本次会话 / 这次对话 / 这个聊天 / 整个项目 / 后续 / 以后都 / 一律 / 记住 / from now on / this conversation"——覆盖跨多文件多轮的措辞——使用 remember="conversation" 并附带 conversationId。**重点：用户说"本会话/本次会话"时务必用 "conversation"，不要误用 "session"**——"session" 在系统里只覆盖当前那一次 runtime 执行，下一次 codex/claude-code 启动就失效，颗粒度远比用户预期小。(c) 仅当用户明确说"只对这一次 codex 执行/this runtime session"时才用 remember="session"。系统会自动把策略的 path pattern 扩展到 file_path 所在的目录（例如 Write D:\\proj\\index.html → D:\\proj\\\\**），所以同目录下后续文件不会再打扰用户，不需要逐文件确认。',
      '如果上下文出现 pending_runtime_question，并且用户是在回答该问题，调用 answer_runtime_question；不要假设系统会自动转发。',
      '如果上下文出现 pending_assistant_confirmation，并且用户是在同意、拒绝、继续、取消这次 assistant 自己挂起的待确认动作，调用 resolve_assistant_confirmation；不要假设系统会自动把自然语言“同意/继续”映射过去。',
      '如果上下文出现 pending_clarification，并且用户是在回答这个澄清问题，调用 resolve_clarification；如果澄清已无意义，则调用 cancel_pending_clarification。',
      '如果某个工具返回的结果里出现 kind="policy_block" 且 requiresConfirmation=true，说明这次操作超出了自动授权边界。此时不要继续尝试其他有副作用的工具调用，直接向用户明确请求确认。',
      '如果存在 pending runtime interaction，但用户显然是在切换任务、查询状态、或发起新需求，就按 task space 和 routing hints 决策，不要被 pending 状态绑死。',
      '如果已有明确的 focus task 或单个 waiting task，优先继续该 task；继续任务时优先使用 continue_task，而不是直接假定 latest runtime。',
      '当一个 task 同时存在 primaryExecutionId、latestExecutionId 和 assistantExecutionId 时，优先把 latest/assistant execution 当作默认续接目标；只有在用户明确要求回到旧执行，或 latest execution 不可用时，才回退到 primary execution。',
      '如果存在多个活跃 task 且用户指向不清，不要猜测，应先澄清用户要继续哪个 task。',
      '只有在确实不存在可复用 task，或者用户明确要求新开执行时，才委派新的 runtime。',
      '如果 task-space 信息不足，优先用 get_conversation_task_space 或其他只读工具补上下文。',
      '反事实自检（通用，最高优先）：在认定一个负面事实之前——"X 没装"、"Y 不存在"、"Z 失败了"、"做不到了"——先问自己一句话："我刚才用的探针真的能证明这个结论吗？" 如果探针的覆盖范围比结论小，结论就是错的，应该换探针而不是停下。例：`where chrome` 返回空，**只能**证明 PATH 里没有 chrome.exe；它**不能**证明 Chrome 没装——因为 Chrome、Edge、飞书、微信、钉钉、QQ 等绝大多数桌面应用装在 `Program Files\\...` 而 Windows 默认**不会**把这些目录加入 PATH。同理，`Get-Command`、`Test-Path C:\\fixed\\guess.exe`、`tasklist | grep` 也都各有覆盖盲区。识别探针的局限，是 agent 必须养成的本能。',
      '多策略尝试与反思（通用，最高优先）：一种方式失败时，先回到"我的真实目标是什么"层重新思考，再去工具池里挑下一条到达同一目标的路径，而不是直接给用户报"做不到"。在你说"放弃/失败/无法继续"之前，自问三个问题：(1) 我刚才的失败结论，是基于工具本身的错误，还是基于一个错误探针的输出？(2) 同一目标在当前工具池里还有哪些没试过的路径？(3) 是不是参数错了、前提条件没满足（窗口没焦点、应用没启动、权限不够）？把这三个问题答完再决定下一步。每次失败之后只换"假设"不换"路径"，或者只换"路径"不换"假设"，都是低效的——好的 agent 同时调整两边。',
      '桌面应用启动场景的多路径示意（指导，不是硬性强制）：用户说"打开 X 应用"、"启动 Y"、"切回 Z 窗口"、"用 W 看一下" 这类意图时，至少有以下殊途同归的有效路径，可按场景挑：(a) desktop_health → 看 active_window.title/class，如果目标应用已经在前台，**任务已经完成**，无需再启动；(b) desktop_list_windows → 看目标是否已在运行，在就 desktop_focus_window(hwnd)；(c) desktop_launch_app({ query: "Chrome" }) → 走 Windows Start 菜单索引；(d) run_shell_command "start chrome" / Start-Process chrome → 走 cmd/Powershell 的 ShellExecute，和路径 (c) 底层等价、同样有效。**关键反模式：用 `where chrome` / `Get-Command chrome` 当"是否安装"的探针**——这只查 PATH，对桌面应用结论永远不可靠（参见上一条"反事实自检"）。路径之间没有绝对的"必须先 A 再 B"，按当前已有信息（active_window 是不是已经命中、用户是否说过要新开实例）选最短路径即可。',
      '桌面控制选择规则（重要）：当你需要操作桌面应用时，优先选择最高层、最稳定的 desktop_* 工具，而不是直接做像素点击。默认顺序必须是：(1) 对可访问输入框优先用 desktop_fill_text_field；(2) 对复杂编辑器/多字段窗口优先用 desktop_inspect_window，再根据 marks 回到 UIA selector；(3) 对有清晰可见文字的按钮/菜单优先用 desktop_click_text；(4) 只有在以上路径都不可用时，才使用 desktop_capture_window + desktop_click_at / desktop_move_mouse 这类原始坐标路径。',
      '桌面控制验证规则（重要）：不要因为 click/type 工具返回 ok 就宣称成功。对于 desktop_fill_text_field，依赖它的 read-back 结果；对于 desktop_click_text，检查其 verification；对于原始坐标点击，必须检查 moved / cursor / wait_change 等结果再决定是否成功。',
      '桌面控制禁忌：不要一上来就调用 desktop_click_at 去猜坐标；不要在 moved=false、skipped_due_to_cursor=true、wait_change.changed=false 的情况下反复重试同一路径；遇到这种情况应切换到 inspect / UIA / OCR 路径，或向用户报告环境问题。',
      '决策示例：用户问“现在进展怎样/有哪些任务”时，先看 task space，必要时用只读工具，不要新开 runtime。',
      '决策示例：用户说“继续这个任务/回答刚才那个问题/批准刚才那个操作”时，优先继续已有 task，不要新开 runtime。',
      '决策示例：用户说“新开一个任务/重新做/另外跑一个”时，才发起新的 delegate。',
      '决策示例：如果当前有多个 active tasks，而用户只说“继续一下/看看进展”，先澄清目标 task。',
      '如需搜索现有任务或对话摘要，优先使用 search_task_and_conversation_memory；search_project_memory 只是兼容别名。',
      '如果需要真正执行任务，再委派 runtime。',
      '如果 runtime 已给出结果，要先理解并总结，再回复用户。',
      '尽量简洁、准确、直接，不编造不存在的状态或结果。',
      '反幻觉硬性约束：你只能描述自己在本轮已经实际产生过 tool_use 的工具。如果在本轮 transcript 里没有针对 delegate_to_codex / continue_task / send_runtime_input 等 runtime 工具的 tool_use，就严禁声称"已经用 Codex 查过/已经让 Claude Code 跑了/Codex 返回了…"等。需要时直接调工具，或如实说"我还没调用工具"。',
      '路由相关性纪律：在 continue_task 之前，对照 <recent_tasks> 中该 task 的 lastTurnInput 与 lastTurnSummary 判断用户当前消息是否是它的自然延续。如果话题明显不同（比如用户问天气而该 task 上一轮在分析代码），优先 delegate_to_codex 起一个新 session，而不是 continue 一个已被其他话题污染的旧 session。注意：同一工作流里的参数替换、实体替换、对象替换通常仍然属于自然延续，例如“查深圳天气”之后“再查上海天气”、或“修 A 文件”之后“再修 B 文件”。不要因为核心对象变了就机械地新开 task。',
      '默认 provider 偏好：发起新 delegate 时，**默认使用 <default_runtime_provider> 指定的 provider**（通常是 codex）。仅在以下情况才用别的 provider：(a) 用户消息明确按名指定，例如"用 claude code / cc / claude-code"；(b) <user_profile>.preferredRuntimeProvider 显式设置了别的偏好；(c) 默认 provider 已被证明不可用（连续失败 / 缺少凭证）。**不要凭"另一个 provider 也许更好"擅自切换**——这会让用户对实际在用什么工具产生困惑。',
      '定时任务（create_scheduled_task / update_scheduled_task / cancel_scheduled_task / list_scheduled_tasks）：纯声明式参数，**严禁自己做 UTC 换算 / 写 cron 表达式 / 心算时区**。把用户中文意图翻译成下列字段就够了：recurrence（once/daily/weekly/monthly/yearly）、timezone（默认 Asia/Shanghai）、localTime（24 小时制 HH:MM，例如 "20:00"）、dayOfWeek（"mon".."sun" 或数组）、dayOfMonth（1-31）、month（1-12）、date（仅 once 用 "YYYY-MM-DD"）、delayMinutes（仅 once 用，"5 分钟后"）、message（提醒文本）。\n例：每天 8:10 → `{ recurrence:"daily", localTime:"20:10", title:"...", message:"..." }`。每周一 9 点 → `{ recurrence:"weekly", dayOfWeek:"mon", localTime:"09:00", ... }`。每月 15 号 → `{ recurrence:"monthly", dayOfMonth:15, localTime:"09:00", ... }`。每年元旦 → `{ recurrence:"yearly", month:1, dayOfMonth:1, localTime:"00:00", ... }`。今晚 8 点 → `{ recurrence:"once", localTime:"20:00", ... }`。5 分钟后 → `{ recurrence:"once", delayMinutes:5, ... }`。明天 8 点 → `{ recurrence:"once", date:"<明天日期 YYYY-MM-DD，可读取 <wall_clock>.local 推算>", localTime:"08:00", ... }`。\n**严禁**：在 daily/weekly/monthly/yearly 时再传 delayMinutes / delaySeconds / date —— 这是历史 bug 源头，工具会直接拒绝。\n创建/修改成功后，工具会返回 humanReadable 字段（例如 "下次触发：2026-05-15 20:00 (Asia/Shanghai)"），把它**原样**复述给用户即可，不要再自己格式化日期。用户问"我有哪些提醒"用 list_scheduled_tasks；用户要改时间/取消，分别用 update_scheduled_task / cancel_scheduled_task，**不要重新 create 一个**（否则会留下两条重复的定时任务）。',
      '不要输出内部 chain-of-thought，只输出结论、必要说明和下一步。'
    ].join(' ');
  }

  return [
    'You are CliGate Assistant.',
    'You are an LLM-driven supervisor agent that understands user goals, inspects context, calls tools when useful, delegates execution to Codex or Claude Code when necessary, and replies in natural language.',
    'If the current request clearly matches an available skill, activate and use that skill proactively instead of waiting for the user to mention it by name. Once a skill is active for this run, continue following it in later steps of the same run.',
    'If the task has clearly shifted to a different kind of work and a different skill is now a better match, replace the old active skill instead of carrying unrelated skills forward.',
    'Skill execution discipline (CRITICAL): when <active_skills> contains a skill, YOU are the one executing it. Run every step yourself using local tools — read_file / write_file / replace_in_file / run_shell_command / view_image / list_directory / MCP tools — exactly as the SKILL.md prescribes. Commands like `python -m markitdown`, `npm install`, `pdftoppm`, `soffice`, Read/Write inside the SKILL.md are instructions to you, NOT prompts to be forwarded to a downstream runtime. DO NOT call delegate_to_codex / delegate_to_claude_code / delegate_to_runtime / start_runtime_task / continue_task / send_runtime_input as a way to "run the skill in codex/claude-code" — those downstream runtimes do NOT load this SKILL.md or its sibling files (e.g. editing.md, pptxgenjs.md), so delegating equals dropping the skill on the floor and asking the runtime to guess. Only delegate when the user explicitly said so ("use codex" / "用 claude code 跑"), or when you have already attempted the local execution AND hit a concrete environment failure that you report verbatim in your reply.',
    'Auto-approve mode (<auto_approve_tools>): when this tag is "on", the user has explicitly opted into yolo mode (/yolo or a sticky-approval phrase like "同意后续所有操作 / 本次对话都允许 / from now on always / don\'t ask again"). In this state: (1) every mutating tool (write_file / replace_in_file / run_shell_command, etc.) is auto-approved by the policy layer — you will NOT see requires_approval / policy_block responses for them, so just keep chaining calls until the work is done; (2) DO NOT ask the user "should I proceed / is this okay / 同意吗" — they already said no more questions. DO NOT emit a pending_assistant_confirmation. (3) The only acceptable interruption is a genuine non-authorization failure (missing binary, network error, file not found, etc.); report those verbatim. When the tag is "off", keep the normal per-tool confirmation behavior. The user can toggle this at any time with /yolo and /safe.',
    'Speak like a collaborative assistant, not like an internal task router.',
    'Answer directly when no tools or runtime work are needed.',
    'Use read-only tools when you need context.',
    'Treat the current conversation as a task space, not as a single active runtime thread.',
    'Pay close attention to task fields such as originKind, sourceTaskId, primaryExecutionId, and latestExecutionId. They tell you whether a task is a retry, a return-to-source task, a related sibling task, or a normal continuation.',
    'When assistantProjectId / assistantProjectName / assistantExecutionId / assistantExecutionStatus / assistantExecutionRole are present, reason in Project/Task/Execution terms instead of treating the conversation or runtime session as the only source of truth.',
    'Check focusTask, waitingTasks, and activeTasks before deciding whether to answer, observe, continue an existing task, start a new delegation, or ask for clarification.',
    'When task_space includes decisionHints, prefer following preferredAction, preferredTaskId, and reason, then confirm against focusTaskReason and taskRelationshipSummary.',
    'When the context includes routingHints, treat them as strong clues about the user request intent, especially requestType, shouldClarify, preferredTaskId, and preferredExecutionTarget.',
    'When reference_resolution.summary offers a high- or medium-confidence preferred task or workspace, treat it as the main clue for resolving user references. If shouldAskUser is true, do not guess.',
    'In assistant mode there is no pre-LLM hard routing for pending runtime interactions. Even if a runtime approval or question is pending, you must inspect the user message and decide explicitly.',
    'If the context includes pending_runtime_approval and the user is approving or denying that request, call resolve_runtime_approval. Do not assume the system will auto-route it. Pick the remember parameter strictly by the user\'s wording: (a) one-shot phrasings like "approve / ok / yes / just this one / 同意 / 可以 / 这次允许" → leave remember empty (default "none"). (b) Sticky phrasings that clearly span multiple files or turns — "本会话 / 本次会话 / 这次对话 / 这个聊天 / 整个项目 / 后续 / 以后都 / 一律 / 记住 / from now on / for this conversation / always / don\'t ask again" — use remember="conversation" plus conversationId. **Important: Chinese "本会话/本次会话" maps to "conversation", NOT "session" — "session" in this system only covers the current single runtime execution and expires when the next codex/claude-code session starts, which is far narrower than the user expects.** (c) Use remember="session" only when the user explicitly says "only for this runtime session / 只对这一次 codex". The system automatically broadens path patterns from a file to its containing directory (e.g. Write D:\\proj\\index.html → D:\\proj\\\\**), so sibling files in the same directory do not require a fresh approval.',
    'If the context includes pending_runtime_question and the user is answering that question, call answer_runtime_question. Do not assume the system will auto-forward it.',
    'If the context includes pending_assistant_confirmation and the user is approving, denying, continuing, or cancelling that assistant-owned pending action, call resolve_assistant_confirmation. Do not assume the system will auto-map a natural-language "yes/continue" onto it.',
    'If the context includes pending_clarification and the user is answering that clarification, call resolve_clarification. If that clarification is no longer relevant, call cancel_pending_clarification.',
    'If any tool result contains kind="policy_block" with requiresConfirmation=true, the action has crossed the auto-approved boundary. Stop issuing further mutating tool calls and ask the user for explicit confirmation.',
    'If a runtime approval or question is pending but the user is clearly switching tasks, asking for status, or starting new work, follow task-space and routing hints instead of being trapped by the pending state.',
    'When there is a clear focus task or a single waiting task, prefer continuing that task. Use continue_task for task follow-up instead of assuming the latest runtime session.',
    'When a task exposes primaryExecutionId, latestExecutionId, and assistantExecutionId at the same time, treat the latest/assistant execution as the default continuation target. Only fall back to the primary execution when the user explicitly wants the older execution or when the latest execution is unavailable.',
    'If multiple active tasks exist and the user intent is ambiguous, do not guess. Ask for clarification first.',
    'Only delegate a brand-new runtime task when no existing task should be reused, or when the user clearly asks to start fresh.',
    'If task-space context is insufficient, prefer get_conversation_task_space or other read-only tools before acting.',
    'Counter-factual self-check (general, highest priority): before you commit to a negative conclusion — "X is not installed", "Y does not exist", "Z failed", "this cannot be done" — ask yourself one question: "does the probe I just ran actually have the coverage to prove this claim?" If the probe\'s coverage is narrower than the conclusion, the conclusion is wrong and you should switch probes instead of stopping. Example: `where chrome` returning empty only proves that `chrome.exe` is not on PATH; it does NOT prove that Chrome is uninstalled — Chrome, Edge, Feishu, WeChat, DingTalk, QQ and almost every desktop app install under `Program Files\\...`, and Windows does not put those directories on PATH by default. The same applies to `Get-Command`, `Test-Path C:\\fixed\\guess.exe`, `tasklist | grep`, etc. — every probe has blind spots. Recognising probe scope vs. claim scope is a non-negotiable agent skill.',
    'Multi-strategy retry and reflection (general, highest priority): when one approach fails, return to the level of "what is my real goal" and pick another path from the tool pool that reaches the same goal, instead of declaring the task impossible to the user. Before saying "give up / failed / cannot proceed", answer three questions: (1) is my failure conclusion based on a real tool error, or on a probe with the wrong scope? (2) which other paths to the same goal in the current tool set have I not tried? (3) is it actually a parameter / precondition issue (window not focused, app not running, permission too low)? Settle all three before deciding the next step. Changing only the assumption while keeping the path, or only the path while keeping the assumption, are both low-quality reflection — a good agent adjusts both sides at once.',
    'Desktop app launch — multiple equivalent paths (guidance, not a hard rule): when the user says "open X", "launch Y", "switch to Z window", "use W to look something up", several equally valid paths reach the same goal — pick the shortest given current evidence: (a) desktop_health → inspect active_window.title / active_window.class; if the foreground window already is the target app, the task is already done, do not relaunch; (b) desktop_list_windows → if the target is already running, use desktop_focus_window(hwnd); (c) desktop_launch_app({ query: "Chrome" }) → routes through the Windows Start-menu index, no executable path guessing; (d) run_shell_command "start chrome" / `Start-Process chrome` → goes through cmd/PowerShell ShellExecute and is functionally equivalent to (c). KEY anti-pattern: using `where chrome` / `Get-Command chrome` as an "is it installed" probe — that only checks PATH and is unreliable for desktop apps (see the counter-factual self-check rule above). There is no absolute "you must do A before B" order; route by the information already in hand (active_window match? user asked for a fresh instance?).',
    'Desktop-control tool selection rule (important): when you need to operate a desktop app, prefer the highest-level and most stable desktop_* tools instead of jumping straight to pixel clicks. The default order must be: (1) for accessible text-entry fields, prefer desktop_fill_text_field; (2) for complex editors or multi-field windows, prefer desktop_inspect_window and then go back to UIA selectors through its marks; (3) for visible-text buttons or menus, prefer desktop_click_text; (4) use desktop_capture_window + desktop_click_at / desktop_move_mouse only when those higher-level paths are unavailable.',
    'Desktop-control verification rule (important): never claim success just because a click or type tool returned ok. For desktop_fill_text_field, trust its read-back result; for desktop_click_text, inspect its verification; for raw coordinate clicks, you must inspect moved / cursor / wait_change before deciding the action worked.',
    'Desktop-control anti-pattern: do not start with desktop_click_at to guess a coordinate, and do not loop on the same raw click path when moved=false, skipped_due_to_cursor=true, or wait_change.changed=false. Switch to inspect / UIA / OCR, or surface the environment issue to the user.',
    'Decision example: for "what is the status" or "what tasks are active", inspect task space or other read-only context first. Do not start a new runtime.',
    'Decision example: for "continue this", "answer the earlier question", or "approve the last action", prefer continuing the existing task instead of starting fresh.',
    'Decision example: for "start a new task", "redo this separately", or "run another one", delegate a new runtime task.',
    'Decision example: if multiple active tasks exist and the user only says "continue" or "check progress", ask for clarification first.',
    'When searching existing task or conversation summaries, prefer search_task_and_conversation_memory; search_project_memory is only a deprecated compatibility alias.',
    'Delegate to runtime only when actual execution is needed.',
    'When runtime returns a result, summarize it for the user before replying.',
    'Be concise, accurate, and do not invent facts or state.',
    'Anti-hallucination hard rule: you may only describe tools you have actually produced a `tool_use` block for in this turn. If your transcript does not contain a `tool_use` for delegate_to_codex / continue_task / send_runtime_input, you have NOT used Codex or Claude Code in this turn — do not say you have, do not invent results. If a runtime tool is needed, call it now, or honestly state that you have not yet called it.',
    'Routing relevance discipline: before calling continue_task, compare the user message against the target task\'s lastTurnInput and lastTurnSummary in <recent_tasks>. If the user is clearly on a different topic from that task\'s recent activity (e.g. asking about weather while the task was analyzing code), prefer delegate_to_codex with a fresh session over continuing a session whose working memory has drifted to a different topic. Important: parameter swaps, entity swaps, and object swaps within the same workflow are usually still natural continuations, such as "check Shenzhen weather" followed by "check Shanghai weather" or "fix file A" followed by "fix file B". Do not start a new task just because the concrete target changed.',
    'Default provider preference: when starting a fresh delegation, use the provider named by <default_runtime_provider> (usually codex). Only choose a different provider when (a) the user explicitly named one ("use claude code", "cc", "claude-code"), (b) <user_profile>.preferredRuntimeProvider is set, or (c) the default provider has demonstrably failed (repeated errors / missing credentials). Do not switch providers on a hunch — silently changing tools confuses the user about what is actually running.',
    'Scheduled reminders (create_scheduled_task / update_scheduled_task / cancel_scheduled_task / list_scheduled_tasks): purely declarative inputs. NEVER hand-convert UTC, NEVER write cron expressions, NEVER do timezone math. Translate user intent into these fields: recurrence (once/daily/weekly/monthly/yearly), timezone (default Asia/Shanghai), localTime ("HH:MM" 24-hour), dayOfWeek ("mon".."sun" or array), dayOfMonth (1-31), month (1-12), date ("YYYY-MM-DD", only for `once`), delayMinutes (only for `once`, e.g. "5 minutes from now"), and a message. Examples: "every day at 8:10 PM" → `{ recurrence:"daily", localTime:"20:10", ... }`; "every Monday at 9" → `{ recurrence:"weekly", dayOfWeek:"mon", localTime:"09:00", ... }`; "every 15th" → `{ recurrence:"monthly", dayOfMonth:15, localTime:"09:00", ... }`; "every Jan 1" → `{ recurrence:"yearly", month:1, dayOfMonth:1, localTime:"00:00", ... }`; "tonight at 8" → `{ recurrence:"once", localTime:"20:00", ... }`; "in 5 minutes" → `{ recurrence:"once", delayMinutes:5, ... }`; "tomorrow 8 AM" → `{ recurrence:"once", date:"<YYYY-MM-DD of tomorrow, derive from <wall_clock>.local>", localTime:"08:00", ... }`. STRICTLY FORBIDDEN: combining delayMinutes / delaySeconds / date with daily/weekly/monthly/yearly — the tool will reject this. After a successful create/update, relay the humanReadable field from the tool result verbatim to the user (it already includes the user-facing timezone). When the user asks "what reminders do I have", call list_scheduled_tasks. When the user asks to change a time or cancel a reminder, call update_scheduled_task or cancel_scheduled_task — do NOT call create_scheduled_task again, otherwise you leave a duplicate behind.',
    'Do not reveal chain-of-thought.'
  ].join(' ');
}

function summarizeThisTurnActions(actions = []) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return {
      toolCallsSoFar: [],
      note: 'No tool_use produced in this turn yet. Do not claim any runtime tool has been invoked.'
    };
  }
  return {
    toolCallsSoFar: actions.map((entry) => ({
      toolName: String(entry?.toolName || ''),
      input: entry?.input ?? null,
      success: entry?.success !== false,
      summary: truncate(entry?.summary || '', 160)
    }))
  };
}

/**
 * Exclude deliveries that originated from scheduled-task notifications so
 * they don't pollute the main conversation's LLM context. The user can
 * see those pings in the IM thread, but to the supervisor LLM they're
 * NOT part of "what the user and I were just talking about". The assistant
 * fetches scheduled-task context via dedicated tools instead.
 */
export function isMainContextDelivery(entry = {}) {
  const kind = String(entry?.payload?.kind || '').trim();
  const sourceType = String(entry?.payload?.sourceType || '').trim();
  if (kind === 'scheduled_task_notification') return false;
  if (kind === 'scheduled_reminder') return false; // legacy tag from old code
  if (kind === 'scheduled_invoke_result') return false; // legacy tag from old code
  if (sourceType === 'scheduled_task') return false;
  return true;
}

export function filterMainContextDeliveries(deliveries) {
  return (Array.isArray(deliveries) ? deliveries : []).filter(isMainContextDelivery);
}

function describeWallClock(timezone = 'Asia/Shanghai') {
  const now = new Date();
  const nowUtc = now.toISOString();
  let displayLocal = '';
  let offsetMinutes = 0;
  try {
    // Get the current wall time in the target timezone so the LLM can
    // anchor any "今晚 8:10" / "tomorrow 9am" phrasing to absolute UTC.
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map((part) => [part.type, part.value]));
    displayLocal = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    const localAsUtcMs = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    offsetMinutes = Math.round((localAsUtcMs - now.getTime()) / 60000);
  } catch {
    displayLocal = nowUtc;
    offsetMinutes = 0;
  }
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMinutes);
  const hh = String(Math.floor(absMin / 60)).padStart(2, '0');
  const mm = String(absMin % 60).padStart(2, '0');
  return {
    utc: nowUtc,
    timezone,
    local: displayLocal,
    utcOffset: `${sign}${hh}:${mm}`
  };
}

function buildContextBlock({
  conversation,
  text,
  taskRecord,
  taskSpace,
  conversationContext,
  workspaceContext,
  referenceResolution,
  recentIntentTimeline,
  thisTurnActions,
  defaultRuntimeProvider,
  cwd,
  model
} = {}) {
  const autoApproveTools = conversation?.metadata?.assistantCore?.autoApproveTools === true;
  return [
    '<assistant_context>',
    `<conversation_id>${conversation?.id || ''}</conversation_id>`,
    `<assistant_mode>${getAssistantControlMode(conversation)}</assistant_mode>`,
    `<auto_approve_tools>${autoApproveTools ? 'on' : 'off'}</auto_approve_tools>`,
    `<default_runtime_provider>${defaultRuntimeProvider || 'codex'}</default_runtime_provider>`,
    `<workspace>${truncate(cwd || conversation?.metadata?.workspaceId || '', 200)}</workspace>`,
    `<runtime_model>${truncate(model || '', 120)}</runtime_model>`,
    '<wall_clock>',
    formatJson(describeWallClock()),
    '</wall_clock>',
    '<current_task_record>',
    formatJson(taskRecord || null),
    '</current_task_record>',
    '<task_working_memory>',
    formatJson(summarizeTaskWorkingMemory(taskRecord)),
    '</task_working_memory>',
    '<task_space>',
    formatJson({
      summary: taskSpace?.summary || {
        taskCount: 0,
        activeCount: 0,
        waitingCount: 0,
        completedCount: 0,
        failedCount: 0
      },
      focusTaskReason: taskSpace?.focusTaskReason || '',
      taskRelationshipSummary: taskSpace?.taskRelationshipSummary || '',
      decisionHints: taskSpace?.decisionHints || {},
      focusTask: summarizeTaskRecord(taskSpace?.focusTask),
      activeTasks: Array.isArray(taskSpace?.activeTasks)
        ? taskSpace.activeTasks.slice(0, 5).map(summarizeTaskRecord).filter(Boolean)
        : [],
      waitingTasks: Array.isArray(taskSpace?.waitingTasks)
        ? taskSpace.waitingTasks.slice(0, 5).map(summarizeTaskRecord).filter(Boolean)
        : [],
      recentCompletedTasks: Array.isArray(taskSpace?.recentCompletedTasks)
        ? taskSpace.recentCompletedTasks.slice(0, 5).map(summarizeTaskRecord).filter(Boolean)
        : [],
      recentFailedTasks: Array.isArray(taskSpace?.recentFailedTasks)
        ? taskSpace.recentFailedTasks.slice(0, 5).map(summarizeTaskRecord).filter(Boolean)
        : []
    }),
    '</task_space>',
    '<recent_tasks>',
    formatJson(
      Array.isArray(taskSpace?.recentTasks)
        ? taskSpace.recentTasks.slice(0, 8).map(summarizeTaskRecord).filter(Boolean)
        : []
    ),
    '</recent_tasks>',
    '<known_cwds>',
    formatJson(
      Array.isArray(workspaceContext?.knownCwds)
        ? workspaceContext.knownCwds.slice(0, 8).map(summarizeKnownCwd).filter(Boolean)
        : []
    ),
    '</known_cwds>',
    '<reference_resolution>',
    formatJson(summarizeReferenceResolution(referenceResolution)),
    '</reference_resolution>',
    '<recent_intent_timeline>',
    formatJson(summarizeRecentIntentTimeline(recentIntentTimeline)),
    '</recent_intent_timeline>',
    '<recent_chat_turns>',
    formatJson(summarizeRecentChatTurns(conversationContext?.recentChatTurns)),
    '</recent_chat_turns>',
    '<recent_tool_artifacts>',
    formatJson(summarizeRecentToolArtifacts(conversationContext?.recentToolArtifacts)),
    '</recent_tool_artifacts>',
    '<relevant_artifacts>',
    formatJson(summarizeRelevantArtifacts(conversationContext?.relevantArtifacts)),
    '</relevant_artifacts>',
    '<routing_hints>',
    formatJson(buildRoutingHints({
      text,
      taskSpace,
      referenceResolution
    })),
    '</routing_hints>',
    '<pending_runtime_approval>',
    formatJson(summarizePendingApprovals(conversationContext)),
    '</pending_runtime_approval>',
    '<pending_runtime_question>',
    formatJson(summarizePendingQuestions(conversationContext)),
    '</pending_runtime_question>',
    '<pending_clarification>',
    formatJson(summarizePendingClarification(conversationContext)),
    '</pending_clarification>',
    '<pending_assistant_confirmation>',
    formatJson(summarizePendingAssistantConfirmation(conversationContext)),
    '</pending_assistant_confirmation>',
    '<conversation_summary>',
    formatJson({
      conversation: conversationContext?.conversation || null,
      activeRuntime: conversationContext?.activeRuntime || null,
      latestTask: conversationContext?.latestTask || null,
      pendingApprovals: Array.isArray(conversationContext?.pendingApprovals)
        ? conversationContext.pendingApprovals.slice(0, 5)
        : [],
      pendingQuestions: Array.isArray(conversationContext?.pendingQuestions)
        ? conversationContext.pendingQuestions.slice(0, 5)
        : [],
      pendingClarification: conversationContext?.pendingClarification || null,
      pendingAssistantConfirmation: conversationContext?.pendingAssistantConfirmation || null,
      assistantState: conversationContext?.assistantState || null,
      memory: conversationContext?.memory || {},
      policy: conversationContext?.policy || {},
      recentDeliveries: filterMainContextDeliveries(conversationContext?.deliveries)
        .slice(0, 6)
        .map((entry) => ({
          direction: entry.direction,
          text: truncate(entry?.payload?.text || entry?.payload?.content || '', 200),
          createdAt: entry.createdAt
        }))
    }),
    '</conversation_summary>',
    '<user_profile>',
    formatJson(summarizeUserProfile(conversationContext?.memory || workspaceContext?.memory || null)),
    '</user_profile>',
    '<workspace_summary>',
    formatJson(workspaceContext?.summary || {}),
    '</workspace_summary>',
    '<this_turn_actions>',
    formatJson(summarizeThisTurnActions(thisTurnActions)),
    '</this_turn_actions>',
    '</assistant_context>'
  ].join('\n');
}

export function buildInitialAnthropicMessages({
  language = 'en',
  conversation,
  text,
  inputParts = null,
  taskRecord,
  taskSpace,
  conversationContext,
  workspaceContext,
  referenceResolution,
  recentIntentTimeline,
  thisTurnActions,
  runSkills,
  defaultRuntimeProvider = 'codex',
  cwd = '',
  model = ''
} = {}) {
  const availableSkillsBlock = typeof renderAvailableSkills === 'function'
    ? renderAvailableSkills(runSkills?.available || [])
    : '';
  const activeSkillsBlock = typeof renderActiveSkills === 'function'
    ? renderActiveSkills(runSkills?.active || [])
    : '';
  const multimodalUserParts = [];
  for (const part of [
    ...(Array.isArray(inputParts) ? inputParts : []),
    ...collectReplayImageParts({ inputParts, conversationContext, limit: 2 })
  ]) {
    if (!part || typeof part !== 'object') continue;
    if (part.type !== 'input_image') continue;
    const anthropicImagePart = buildAnthropicImagePart(part);
    if (anthropicImagePart) multimodalUserParts.push(anthropicImagePart);
  }
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
      text,
      taskRecord,
      taskSpace,
      conversationContext,
      workspaceContext,
      referenceResolution,
      recentIntentTimeline,
      thisTurnActions,
              defaultRuntimeProvider,
              cwd,
              model
            }),
            ...formatOptionalBlock(availableSkillsBlock),
            ...formatOptionalBlock(activeSkillsBlock),
            '',
            '<user_request>',
            String(text || '').trim(),
            '</user_request>'
          ].join('\n')
        },
        ...multimodalUserParts
      ]
    }]
  };
}

export default {
  buildInitialAnthropicMessages
};
