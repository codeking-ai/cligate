import path from 'node:path';
import { ASSISTANT_RUN_STATUS, ASSISTANT_RUN_CLOSURE_STATE } from '../assistant-core/models.js';
import { createAssistantRunCheckpoint } from '../assistant-core/models.js';
import assistantRunStore from '../assistant-core/run-store.js';
import runResourceRegistry, { DESKTOP_INPUT_TOOLS, DESKTOP_RESOURCE } from '../assistant-core/run-resource-registry.js';
import { buildAnthropicToolDefinitions } from './tool-schema.js';
import { buildInitialAnthropicMessages } from './prompt-builder.js';
import { deriveAssistantRunStopState } from './stop-policy.js';
import { composeAssistantReply } from './response-composer.js';
import assistantReflectionService, { AssistantReflectionService } from './reflection-service.js';
import {
  extractToolResultSession,
  normalizeAssistantToolResultEntry,
  stringifyAssistantToolResult
} from './tool-result.js';
import {
  skillManager,
  collectExplicitSkillMentions,
  collectSuggestedSkills,
  activateSkillsForRun,
  restoreActiveSkillsFromCheckpoint,
  replaceActiveSkills,
  shouldReplaceActiveSkills
} from '../skills/index.js';

function nowIso() {
  return new Date().toISOString();
}

function isChineseText(text) {
  return /[\u3400-\u9fff]/.test(String(text || ''));
}

// A continuation / auto turn \u2014 e.g. the "[Assistant continuation \u2014 system
// auto-message, not from the user] \u2026" prompt spawned after a tool approval \u2014
// is system-generated and hardcoded English. It is NOT a signal of the user's
// language. Detecting reply language from it is what flipped a Chinese
// conversation into English confirmation prompts mid-task (the "\u4e2d\u82f1\u6587\u4e24\u7248"
// approval requests the user saw: turn 1 in Chinese, the continuation turns in
// English).
function isSystemAuthoredTurn(text) {
  const trimmed = String(text || '').trimStart();
  if (!trimmed) return true;
  return trimmed.startsWith('[Assistant continuation')
    || trimmed.includes('system auto-message')
    || trimmed.includes('not from the user');
}

// Resolve the assistant's reply language from the user's actual language rather
// than the current turn's raw text. The current text is authoritative only when
// it is a genuine user message; for system-authored continuation turns we look
// back to the most recent real user turn so the language stays consistent for
// the whole task (every confirmation prompt in the user's language).
export function resolveReplyLanguage(text, conversationContext = null) {
  if (text && !isSystemAuthoredTurn(text)) {
    return isChineseText(text) ? 'zh-CN' : 'en';
  }
  const turns = Array.isArray(conversationContext?.recentChatTurns)
    ? conversationContext.recentChatTurns
    : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (String(turn?.role || '') !== 'user') continue;
    const turnText = String(turn?.text || '');
    if (!turnText || isSystemAuthoredTurn(turnText)) continue;
    return isChineseText(turnText) ? 'zh-CN' : 'en';
  }
  return isChineseText(text) ? 'zh-CN' : 'en';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// How long a desktop-class tool call will queue behind another run that holds
// the desktop before giving up and handing a "busy" result back to the LLM so
// it can decide what to do next (ask the user, do non-desktop work, etc.).
const DESKTOP_LEASE_WAIT_MS = 5 * 60 * 1000;
const DESKTOP_LEASE_POLL_MS = 1500;

function appendAssistantToolMessage(messages, completion) {
  const content = [];
  if (completion.text) {
    content.push({
      type: 'text',
      text: completion.text
    });
  }
  for (const call of completion.toolCalls || []) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.input || {}
    });
  }
  if (content.length > 0) {
    messages.push({
      role: 'assistant',
      content
    });
  }
}

function appendToolResultMessage(messages, toolCall, toolResult) {
  const payload = normalizeAssistantToolResultEntry(toolResult, {
    toolName: toolCall?.name || ''
  }).payload;
  let content = stringifyAssistantToolResult(toolResult);
  if (Array.isArray(payload?.content) && payload.content.length > 0) {
    content = payload.content;
  }
  messages.push({
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: toolCall.id,
      content
    }]
  });
}

function summarizeToolStep(toolName, result) {
  const normalized = normalizeAssistantToolResultEntry(result, { toolName });
  return {
    kind: 'tool',
    toolName: normalized.toolName || toolName,
    status: normalized.success === false ? 'failed' : 'completed',
    summary: normalized.summary,
    startedAt: normalized.startedAt || nowIso(),
    completedAt: normalized.completedAt || nowIso()
  };
}

// Default ReAct iteration budget. Why this is high:
//   - Skills (pptx, markitdown) easily need 10-15 round-trips
//   - Desktop control flows (open app → focus → find/scroll → fill many fields →
//     save → verify) routinely need 40-60 tool calls — each click/type/scroll
//     plus a screenshot to verify is one iteration
//   - At the old cap of 30 a single WeChat MP article publish hit
//     "tool_phase_finished_without_assistant_summary" mid-flow and the user
//     had to manually type "继续" to spawn a fresh run
// Reference: Codex/Claude Code don't cap on iteration count — they cap on
// context tokens via in-place compaction. We still cap on iterations because we
// don't yet have compaction, but the cap should be high enough that real tasks
// finish in one run. Operator can override via CLIGATE_ASSISTANT_MAX_ITERATIONS
// env var, clamped to [1, 200] to keep a runaway loop from burning unbounded
// tokens.
function resolveDefaultMaxIterations() {
  const raw = Number.parseInt(String(process.env.CLIGATE_ASSISTANT_MAX_ITERATIONS || '').trim(), 10);
  if (Number.isFinite(raw)) {
    return Math.min(200, Math.max(1, raw));
  }
  return 60;
}

// How many times we escalate max_tokens and retry the SAME turn when the model
// hits the output budget mid tool_use arguments. Mirrors claude-code's
// MAX_OUTPUT_TOKENS_RECOVERY_LIMIT. After this many attempts the engine falls
// through with the truncated calls; the tool executor recognises the
// __truncated marker and returns a recoverable failure result so the next
// iteration's LLM can adapt instead of crashing on undefined fields.
const MAX_TRUNCATION_RETRIES = 2;
const TRUNCATION_BASE_TOKENS = 16384;

function detectTruncation(completion) {
  if (!completion) return false;
  if (completion.stopReason === 'max_tokens') return true;
  const calls = Array.isArray(completion.toolCalls) ? completion.toolCalls : [];
  return calls.some((call) => (
    call?.input?.__truncated === true
    || call?.__truncated === true
  ));
}

function escalatedMaxTokens(previousMaxTokens, attemptIndex) {
  // Double on each retry, anchored at TRUNCATION_BASE_TOKENS so even providers
  // that didn't report their effective cap get a meaningful bump. Clamp to a
  // generous-but-finite ceiling so a stuck retry loop can't burn unbounded
  // tokens against an upstream that lies about its real limit.
  const base = Number.isFinite(previousMaxTokens) && previousMaxTokens > 0
    ? previousMaxTokens
    : TRUNCATION_BASE_TOKENS;
  const grown = base * Math.pow(2, Math.max(1, attemptIndex));
  return Math.min(65536, Math.max(base, grown));
}

export class AssistantReactEngine {
  constructor({
    llmClient,
    toolRegistry,
    toolExecutor,
    reflectionService = assistantReflectionService,
    runEventStore = null,
    runStore = assistantRunStore,
    maxIterations = resolveDefaultMaxIterations()
  } = {}) {
    this.llmClient = llmClient;
    this.toolRegistry = toolRegistry;
    this.toolExecutor = toolExecutor;
    this.runEventStore = runEventStore;
    this.runStore = runStore;
    this.reflectionService = reflectionService instanceof AssistantReflectionService
      ? reflectionService
      : reflectionService;
    this.maxIterations = maxIterations;
  }

  emitTrace(runId, event = {}) {
    if (!this.runEventStore?.append || !runId) return null;
    return this.runEventStore.append(runId, event);
  }

  // Read the run's *persisted* status. workingRun is a local copy that stays
  // RUNNING for the whole loop, so the only authoritative signal that a
  // supervisor tool / the user cancelled this run mid-flight lives in the
  // store record (the same source the wait-tools poll). Fail-open: if the
  // store read throws, report "not cancelled" so a flaky read never wedges a
  // healthy run.
  isRunCancelled(runId) {
    if (!runId || !this.runStore?.get) return false;
    try {
      const record = this.runStore.get(runId);
      return String(record?.status || '').trim() === ASSISTANT_RUN_STATUS.CANCELLED;
    } catch {
      return false;
    }
  }

  // Ensure this run holds the desktop lease before it drives the mouse/keyboard.
  // Independent (non-desktop) work never reaches this — only the input-grabbing
  // desktop tools do. If another run holds the desktop, this queues (event-driven
  // poll, cancellable) until released, then proceeds — realizing "second desktop
  // task waits and auto-starts when the first finishes". If it can't acquire
  // within the window (or the run is cancelled), it returns ok:false so the
  // caller hands a structured "busy" result back to the LLM to decide.
  async ensureDesktopLease(workingRun, conversation, runId) {
    const info = {
      title: String(workingRun?.triggerText || '').slice(0, 80),
      conversationId: String(conversation?.id || '')
    };
    const first = runResourceRegistry.tryAcquire(DESKTOP_RESOURCE, runId, info);
    if (first.ok) return { ok: true, waitedMs: 0 };

    // Held by another run — tell the user (once) that we're queued behind it.
    this.emitTrace(workingRun.id, {
      type: 'assistant.resource.queued',
      phase: 'tool',
      status: 'running',
      title: 'Waiting for desktop',
      summary: `Desktop is in use by another task (run ${String(first.holder?.runId || '').slice(0, 8)}); queued behind it.`,
      payload: { resource: DESKTOP_RESOURCE, holder: first.holder || null },
      visibility: 'compact'
    });

    const startedAt = Date.now();
    const deadline = startedAt + DESKTOP_LEASE_WAIT_MS;
    while (Date.now() <= deadline) {
      if (this.isRunCancelled(runId)) {
        return { ok: false, reason: 'cancelled' };
      }
      await sleep(DESKTOP_LEASE_POLL_MS);
      const acq = runResourceRegistry.tryAcquire(DESKTOP_RESOURCE, runId, info);
      if (acq.ok) return { ok: true, waitedMs: Date.now() - startedAt };
    }
    return {
      ok: false,
      reason: 'timeout',
      waitedMs: Date.now() - startedAt,
      holder: runResourceRegistry.getHolder(DESKTOP_RESOURCE)
    };
  }

  async run({
    run,
    conversation,
    text,
    inputParts = null,
    taskRecord = null,
    taskSpace = null,
    conversationContext = null,
    workspaceContext = null,
    referenceResolution = null,
    recentIntentTimeline = null,
    defaultRuntimeProvider = 'codex',
    cwd = '',
    model = ''
  } = {}) {
    const language = resolveReplyLanguage(text, conversationContext);
    const discoveredSkills = skillManager.discoverForCwd(cwd || process.cwd()).skills;
    const restoredSkills = restoreActiveSkillsFromCheckpoint(run);
    const explicitSkills = collectExplicitSkillMentions(text, discoveredSkills);
    const selectedSkills = explicitSkills.length > 0
      ? explicitSkills
      : collectSuggestedSkills(text, discoveredSkills);
    const baseRun = shouldReplaceActiveSkills(text, restoredSkills.active, discoveredSkills)
      ? {
          ...run,
          metadata: {
            ...(run?.metadata || {}),
            skills: replaceActiveSkills(run, [])
          }
        }
      : {
          ...run,
          metadata: {
            ...(run?.metadata || {}),
            skills: restoredSkills
          }
        };
    const runSkills = activateSkillsForRun({
      run: baseRun,
      availableSkills: discoveredSkills,
      selectedSkills,
      loadSkillContent: (skill) => skillManager.loadSkillContent(skill)
    });
    const prompt = buildInitialAnthropicMessages({
      language,
      conversation,
      text,
      inputParts,
      taskRecord,
      taskSpace,
      conversationContext,
      workspaceContext,
      referenceResolution,
      recentIntentTimeline,
      runSkills,
      defaultRuntimeProvider,
      cwd,
      model
    });
    const toolDefinitions = buildAnthropicToolDefinitions(this.toolRegistry);
    const transcript = [...prompt.messages];
    const toolResults = [];
    const relatedRuntimeSessionIds = new Set(run?.relatedRuntimeSessionIds || []);
    let llmSource = null;
    let finalText = '';
    let maxIterationsReached = true;

    let workingRun = this.toolExecutor.policyService ? run : run;
    workingRun = {
      ...workingRun,
      status: ASSISTANT_RUN_STATUS.RUNNING,
      steps: Array.isArray(workingRun?.steps) ? [...workingRun.steps] : [],
      metadata: {
        ...(workingRun?.metadata || {}),
        agent: {
          mode: 'react',
          phase: 'phase-a-b-c',
          defaultRuntimeProvider,
          cwd,
          requestedModel: model || '',
          iterations: 0
        },
        skills: runSkills
      }
    };

    this.emitTrace(workingRun.id, {
      type: 'assistant.run.started',
      phase: 'start',
      status: ASSISTANT_RUN_STATUS.RUNNING,
      title: 'Assistant run started',
      summary: text ? `Started: ${String(text).slice(0, 160)}` : 'Assistant run started',
      payload: {
        conversationId: conversation?.id || '',
        mode: workingRun.mode || '',
        defaultRuntimeProvider,
        cwd,
        model: model || ''
      },
      visibility: 'compact'
    });

    let llmFailure = null;
    let cancelledMidRun = false;
    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      const iterationNumber = iteration + 1;

      // Cancellation enforcement at the loop boundary. If a supervisor tool or
      // the user flipped this run's persisted status to CANCELLED, unwind
      // cleanly before spending another LLM turn or issuing more tool calls.
      // (Before this guard the loop ran ~10 more iterations after a cancel and
      // only a wait-tool happened to notice — the 2026-06-02 incident.)
      if (this.isRunCancelled(run?.id)) {
        cancelledMidRun = true;
        maxIterationsReached = false;
        break;
      }

      // Truncation-recovery inner loop. The supervisor LLM can hit the model's
      // max_output_tokens while still inside a tool_use's arguments JSON; the
      // response translator marks the partial call with __truncated. Re-issue
      // the *same* turn with an escalated max_tokens before falling through, so
      // the bad partial call never reaches the tool executor when avoidable.
      let completion = null;
      let truncationAttempts = 0;
      let truncationOverride = null;
      let truncationError = null;
      while (true) {
        this.emitTrace(workingRun.id, {
          type: 'assistant.llm.requested',
          phase: 'llm',
          status: 'running',
          title: truncationAttempts > 0
            ? `LLM turn ${iterationNumber} (retry ${truncationAttempts} after truncation)`
            : `LLM turn ${iterationNumber}`,
          summary: truncationAttempts > 0
            ? `Retrying turn ${iterationNumber} with max_tokens=${truncationOverride} after the previous response hit the output budget.`
            : `Calling assistant model for iteration ${iterationNumber}.`,
          payload: {
            iteration: iterationNumber,
            attempt: truncationAttempts + 1,
            messageCount: transcript.length,
            toolCount: toolDefinitions.length,
            model: model || '',
            maxTokensOverride: truncationOverride
          },
          visibility: 'detail'
        });

        try {
          completion = await this.llmClient.complete({
            system: prompt.system,
            messages: transcript,
            tools: toolDefinitions,
            model,
            maxTokens: truncationOverride
          });
        } catch (error) {
          truncationError = error;
          break;
        }

        if (detectTruncation(completion) && truncationAttempts < MAX_TRUNCATION_RETRIES) {
          truncationAttempts += 1;
          const previousCap = completion?.source?.maxTokens;
          truncationOverride = escalatedMaxTokens(previousCap, truncationAttempts);
          this.emitTrace(workingRun.id, {
            type: 'assistant.llm.truncated',
            phase: 'llm',
            status: 'retrying',
            title: `Turn ${iterationNumber} truncated, escalating max_tokens to ${truncationOverride}`,
            summary: `Model hit max_output_tokens (stopReason=${completion?.stopReason || 'unknown'}). Discarding partial tool_use and retrying.`,
            payload: {
              iteration: iterationNumber,
              attempt: truncationAttempts,
              previousMaxTokens: previousCap || null,
              nextMaxTokens: truncationOverride,
              stopReason: completion?.stopReason || '',
              partialToolCalls: (completion?.toolCalls || []).map((call) => ({
                id: call.id,
                name: call.name,
                truncated: call?.input?.__truncated === true || call?.__truncated === true
              }))
            },
            visibility: 'detail'
          });
          continue;
        }
        break;
      }

      // LLM call threw (network/upstream timeout, all tiers failed). Emit a
      // structured failure trace so the dashboard shows what happened instead
      // of the previous "completed" status from an earlier tool, then end the
      // run cleanly via the normal stop-policy path.
      if (truncationError && !completion) {
        const message = String(truncationError?.message || truncationError || 'assistant_llm_error');
        llmFailure = {
          message,
          code: truncationError?.code || 'assistant_llm_error'
        };
        this.emitTrace(workingRun.id, {
          type: 'assistant.llm.failed',
          phase: 'llm',
          status: 'failed',
          title: `LLM turn ${iterationNumber} failed`,
          summary: message.slice(0, 300),
          payload: {
            iteration: iterationNumber,
            attempt: truncationAttempts + 1,
            error: message,
            code: llmFailure.code
          },
          visibility: 'compact'
        });
        finalText = '';
        maxIterationsReached = false;
        break;
      }

      llmSource = completion.source;
      const completionText = String(completion.text || '').trim();
      const toolNames = (completion.toolCalls || []).map((call) => call.name).filter(Boolean);
      // The thinking text the LLM emits before its tool_use block is the user's
      // only window into supervisor reasoning. Surface it in BOTH the event
      // summary (so the trace panel renders "what the model just said" instead
      // of just a list of tool names) AND in payload.thinkingText (so clients
      // that want it separately can grab the raw string). When the model emits
      // both text and tool calls, we show the text + a compact tool-name tail
      // so users see thinking first, mechanics second.
      const traceTitle = completionText
        ? 'Model thinking + tool call'
        : (toolNames.length
          ? `Model requested ${toolNames.length} tool call(s)`
          : 'Model produced a reply');
      const traceSummary = completionText
        ? (toolNames.length
          ? `${completionText}\n→ Next: ${toolNames.join(', ')}`
          : completionText)
        : (toolNames.length ? `Requested tools: ${toolNames.join(', ')}` : '');
      this.emitTrace(workingRun.id, {
        type: 'assistant.llm.completed',
        phase: 'llm',
        status: 'completed',
        title: traceTitle,
        summary: traceSummary,
        payload: {
          iteration: iterationNumber,
          source: completion.source || null,
          truncationAttempts,
          stopReason: completion.stopReason || '',
          toolCalls: (completion.toolCalls || []).map((call) => ({
            id: call.id,
            name: call.name,
            input: call.input || {},
            truncated: call?.input?.__truncated === true || call?.__truncated === true
          })),
          hasText: Boolean(completionText),
          thinkingText: completionText
        },
        visibility: 'detail'
      });
      workingRun.steps.push({
        kind: 'assistant_turn',
        status: 'completed',
        summary: completion.toolCalls?.length
          ? `Assistant requested ${completion.toolCalls.length} tool call(s)`
          : 'Assistant produced a direct reply',
        model: completion.source?.model || '',
        source: completion.source?.kind || '',
        completedAt: nowIso()
      });
      workingRun.metadata = {
        ...(workingRun.metadata || {}),
        agent: {
          ...(workingRun.metadata?.agent || {}),
          iterations: iteration + 1,
          llmSource
        },
        toolResults: toolResults.map((entry) => ({
          toolName: String(entry?.toolName || ''),
          input: entry?.input || {},
          status: entry?.status || '',
          success: entry?.status === 'completed',
          summary: String(entry?.content?.[0]?.text || ''),
          result: entry?.structured ?? null,
          metadata: entry?.metadata || {}
        })),
        checkpoint: createAssistantRunCheckpoint({
          completedStepCount: workingRun.steps.length,
          toolResults,
          lastCompletedStep: workingRun.steps[workingRun.steps.length - 1] || null,
          resumable: stopStateLikeWaitingUser(toolResults),
          skills: workingRun?.metadata?.skills || null
        })
      };

      if (!completion.toolCalls || completion.toolCalls.length === 0) {
        finalText = String(completion.text || '').trim();
        maxIterationsReached = false;
        break;
      }

      appendAssistantToolMessage(transcript, completion);

      // Compute per-turn execution context shared by every tool call this turn:
      //   - autoApproveAll: conversation-level "yolo" flag set by /yolo or by a
      //     sticky-approval phrase in chat-ui-route. Skips the per-tool
      //     confirmation prompt for mutating tools.
      //   - extraReadRoots: directories of skills active in this run. Lets
      //     read_file / list_directory / stat_path open SKILL.md siblings
      //     (editing.md, pptxgenjs.md, scripts/) even when the workspace cwd
      //     lives on a different drive than ~/.cligate/skills/<name>/.
      const autoApproveAll = conversation?.metadata?.assistantCore?.autoApproveTools === true;
      const activeSkillReadRoots = (workingRun?.metadata?.skills?.active || [])
        .map((skill) => {
          const skillPath = String(skill?.pathToSkillMd || '').trim();
          return skillPath ? path.dirname(skillPath) : '';
        })
        .filter(Boolean);
      // Sticky read roots the user granted in natural language ("可读C盘") earlier
      // in this conversation. Persisted on the conversation, applied to every
      // run so the grant survives short follow-ups and fresh runs.
      const grantedReadRoots = Array.isArray(conversation?.metadata?.assistantCore?.grantedReadRoots)
        ? conversation.metadata.assistantCore.grantedReadRoots
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
        : [];
      const extraReadRoots = [...new Set([...activeSkillReadRoots, ...grantedReadRoots])];

      for (const toolCall of completion.toolCalls) {
        const toolStartedAt = Date.now();
        this.emitTrace(workingRun.id, {
          type: 'assistant.tool.started',
          phase: 'tool',
          status: 'running',
          title: toolCall.name,
          summary: `Running tool ${toolCall.name}.`,
          payload: {
            iteration: iterationNumber,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            input: toolCall.input || {}
          },
          visibility: 'compact'
        });
        // Desktop input tools must hold the single physical mouse/keyboard.
        // Acquire (or queue for) the desktop lease first; only hand the call to
        // the executor once this run owns the device. If the lease can't be had,
        // synthesize a recoverable "busy" result so the LLM can decide what to do
        // — instead of two runs fighting over the desktop.
        let result = null;
        if (DESKTOP_INPUT_TOOLS.has(toolCall.name)) {
          const gate = await this.ensureDesktopLease(workingRun, conversation, run?.id);
          if (!gate.ok) {
            const busyText = gate.reason === 'cancelled'
              ? 'Desktop wait aborted: this run was cancelled.'
              : `Desktop is still held by another task after waiting ${Math.round((gate.waitedMs || 0) / 1000)}s. `
                + 'It was NOT touched. Tell the user it is still busy, or do non-desktop work and retry later.';
            result = {
              status: 'failed',
              content: [{ type: 'text', text: busyText }],
              structured: {
                kind: 'resource_busy',
                resource: DESKTOP_RESOURCE,
                reason: gate.reason || 'busy',
                holder: gate.holder || null
              },
              metadata: { recoverable: true, resourceGate: true }
            };
          }
        }
        if (!result) {
          result = await this.toolExecutor.executeToolCall({
            toolName: toolCall.name,
            input: toolCall.input || {}
          }, {
            run: workingRun,
            conversation,
            cwd,
            autoApproveAll,
            extraReadRoots
          });
        }
        const recordedResult = {
          ...result,
          toolName: toolCall.name,
          input: toolCall.input || {}
        };
        toolResults.push(recordedResult);
        workingRun.steps.push(summarizeToolStep(toolCall.name, recordedResult));
        const normalizedResult = normalizeAssistantToolResultEntry(recordedResult, {
          toolName: toolCall.name
        });
        this.emitTrace(workingRun.id, {
          type: normalizedResult.success === false ? 'assistant.tool.failed' : 'assistant.tool.completed',
          phase: 'tool',
          status: normalizedResult.success === false ? 'failed' : (normalizedResult.status || 'completed'),
          title: normalizedResult.toolName || toolCall.name,
          summary: normalizedResult.summary || `Tool ${toolCall.name} completed.`,
          payload: {
            iteration: iterationNumber,
            toolCallId: toolCall.id,
            toolName: normalizedResult.toolName || toolCall.name,
            durationMs: Date.now() - toolStartedAt,
            result: normalizedResult.payload || null,
            structured: recordedResult?.structured ?? null,
            metadata: recordedResult?.metadata || {}
          },
          visibility: 'detail'
        });

        const session = extractToolResultSession(recordedResult);
        if (session?.id && session?.provider) {
          relatedRuntimeSessionIds.add(session.id);
          this.emitTrace(workingRun.id, {
            type: 'assistant.runtime.linked',
            phase: 'runtime',
            status: session.status || 'running',
            title: `${session.provider} runtime`,
            summary: `Linked runtime session ${String(session.id).slice(0, 8)}.`,
            payload: {
              runtimeSessionId: session.id,
              provider: session.provider,
              status: session.status || '',
              title: session.title || ''
            },
            visibility: 'compact'
          });
        }

        appendToolResultMessage(transcript, toolCall, recordedResult);

        const reflected = await this.reflectionService.expandToolResults({
          toolCall: { toolName: toolCall.name, input: toolCall.input || {} },
          toolResult: recordedResult,
          toolExecutor: this.toolExecutor,
          context: {
            run: workingRun,
            conversation,
            cwd
          }
        });
        for (const extra of reflected) {
          toolResults.push(extra);
          workingRun.steps.push(summarizeToolStep(extra.toolName, extra));
          const normalizedExtra = normalizeAssistantToolResultEntry(extra, {
            toolName: extra.toolName
          });
          this.emitTrace(workingRun.id, {
            type: normalizedExtra.success === false ? 'assistant.tool.failed' : 'assistant.tool.completed',
            phase: 'reflection',
            status: normalizedExtra.success === false ? 'failed' : (normalizedExtra.status || 'completed'),
            title: normalizedExtra.toolName || extra.toolName,
            summary: normalizedExtra.summary || `Reflected tool ${extra.toolName}.`,
            payload: {
              parentToolCallId: toolCall.id,
              toolName: normalizedExtra.toolName || extra.toolName,
              result: normalizedExtra.payload || null,
              structured: extra?.structured ?? null,
              metadata: extra?.metadata || {}
            },
            visibility: 'detail'
          });
          appendToolResultMessage(transcript, {
            id: `${toolCall.id}:${extra.toolName}`,
            name: extra.toolName
          }, extra);
        }
      }
    }

    // A mid-loop cancellation wins over whatever the stop policy would infer:
    // a cancelled run must finalize as CANCELLED, not be overwritten with
    // "completed" (which previously let a cancelled run deliver a result).
    const stopState = cancelledMidRun
      ? {
          status: ASSISTANT_RUN_STATUS.CANCELLED,
          reason: 'assistant_run_cancelled',
          closure: ASSISTANT_RUN_CLOSURE_STATE.CANCELLED
        }
      : deriveAssistantRunStopState({
          toolResults,
          assistantText: finalText,
          maxIterationsReached,
          llmFailure
        });
    const finalStatus = stopState.status;
    const reply = composeAssistantReply({
      language,
      assistantText: finalText,
      toolResults,
      finalStatus,
      stopReason: stopState.reason
    });

    workingRun = {
      ...workingRun,
      relatedRuntimeSessionIds: [...relatedRuntimeSessionIds],
      status: finalStatus,
      summary: reply.summary,
      result: reply.message,
      metadata: {
        ...(workingRun.metadata || {}),
        toolResults: toolResults.map((entry) => ({
          toolName: String(entry?.toolName || ''),
          input: entry?.input || {},
          status: entry?.status || '',
          success: entry?.status === 'completed',
          summary: String(entry?.content?.[0]?.text || ''),
          result: entry?.structured ?? null,
          metadata: entry?.metadata || {}
        })),
        checkpoint: createAssistantRunCheckpoint({
          completedStepCount: workingRun.steps.length,
          toolResults,
          lastCompletedStep: workingRun.steps[workingRun.steps.length - 1] || null,
          resumable: finalStatus === ASSISTANT_RUN_STATUS.WAITING_USER,
          skills: workingRun?.metadata?.skills || null
        }),
        stopPolicy: stopState
      }
    };

    this.emitTrace(workingRun.id, {
      type: finalStatus === ASSISTANT_RUN_STATUS.FAILED
        ? 'assistant.run.failed'
        : finalStatus === ASSISTANT_RUN_STATUS.CANCELLED
          ? 'assistant.run.cancelled'
          : 'assistant.run.completed',
      phase: 'finish',
      status: finalStatus,
      title: reply.summary || 'Assistant run finished',
      summary: reply.message || reply.summary || '',
      payload: {
        status: finalStatus,
        stopPolicy: stopState,
        relatedRuntimeSessionIds: [...relatedRuntimeSessionIds],
        stepCount: workingRun.steps.length,
        toolResultCount: toolResults.length
      },
      visibility: 'compact'
    });

    // This run is finishing — free any exclusive resource it held (e.g. the
    // desktop) so a queued run can proceed immediately. The registry's
    // stale-reclaim is the backstop if this is ever skipped (e.g. a throw).
    runResourceRegistry.releaseAllForRun(run?.id);

    return {
      run: workingRun,
      toolResults,
      reply,
      llmSource
    };
  }
}

export default AssistantReactEngine;

function stopStateLikeWaitingUser(toolResults = []) {
  return Array.isArray(toolResults) && toolResults.some((entry) => entry?.status === 'requires_approval');
}
