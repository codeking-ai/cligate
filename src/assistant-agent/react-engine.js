import path from 'node:path';
import { ASSISTANT_RUN_STATUS } from '../assistant-core/models.js';
import { createAssistantRunCheckpoint } from '../assistant-core/models.js';
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

// Default ReAct iteration budget. The old value of 6 was a relic from when the
// supervisor was supposed to make a quick routing decision and then delegate to
// codex/claude-code. After we shifted skill execution back into the supervisor
// itself (so it can run shell commands, write files, generate scripts, etc.),
// 6 turns is nowhere near enough — a real skill workflow like the pptx skill
// can need 10-15 LLM→tool→LLM round-trips before producing the final reply.
// At 6 turns the run silently truncates to "tool_phase_finished_without_assistant_summary",
// and the user sees the previous tool's status text ("Tool run_shell_command completed")
// instead of a real answer. Bump well above the natural pptx ceiling, allow the
// operator to raise/lower via env, and clamp to a sane range so nothing can
// burn unbounded tokens.
function resolveDefaultMaxIterations() {
  const raw = Number.parseInt(String(process.env.CLIGATE_ASSISTANT_MAX_ITERATIONS || '').trim(), 10);
  if (Number.isFinite(raw)) {
    return Math.min(80, Math.max(1, raw));
  }
  return 30;
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
    maxIterations = resolveDefaultMaxIterations()
  } = {}) {
    this.llmClient = llmClient;
    this.toolRegistry = toolRegistry;
    this.toolExecutor = toolExecutor;
    this.runEventStore = runEventStore;
    this.reflectionService = reflectionService instanceof AssistantReflectionService
      ? reflectionService
      : reflectionService;
    this.maxIterations = maxIterations;
  }

  emitTrace(runId, event = {}) {
    if (!this.runEventStore?.append || !runId) return null;
    return this.runEventStore.append(runId, event);
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
    const language = isChineseText(text) ? 'zh-CN' : 'en';
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
    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      const iterationNumber = iteration + 1;

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
      this.emitTrace(workingRun.id, {
        type: 'assistant.llm.completed',
        phase: 'llm',
        status: 'completed',
        title: completion.toolCalls?.length
          ? `Model requested ${completion.toolCalls.length} tool call(s)`
          : 'Model produced a reply',
        summary: completion.toolCalls?.length
          ? `Requested tools: ${completion.toolCalls.map((call) => call.name).filter(Boolean).join(', ')}`
          : String(completion.text || '').trim().slice(0, 300),
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
          hasText: Boolean(String(completion.text || '').trim())
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
      const extraReadRoots = (workingRun?.metadata?.skills?.active || [])
        .map((skill) => {
          const skillPath = String(skill?.pathToSkillMd || '').trim();
          return skillPath ? path.dirname(skillPath) : '';
        })
        .filter(Boolean);

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
        const result = await this.toolExecutor.executeToolCall({
          toolName: toolCall.name,
          input: toolCall.input || {}
        }, {
          run: workingRun,
          conversation,
          cwd,
          autoApproveAll,
          extraReadRoots
        });
        toolResults.push(result);
        workingRun.steps.push(summarizeToolStep(toolCall.name, result));
        const normalizedResult = normalizeAssistantToolResultEntry(result, {
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
            structured: result?.structured ?? null,
            metadata: result?.metadata || {}
          },
          visibility: 'detail'
        });

        const session = extractToolResultSession(result);
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

        appendToolResultMessage(transcript, toolCall, result);

        const reflected = await this.reflectionService.expandToolResults({
          toolCall: { toolName: toolCall.name, input: toolCall.input || {} },
          toolResult: result,
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

    const stopState = deriveAssistantRunStopState({
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
      type: finalStatus === ASSISTANT_RUN_STATUS.FAILED ? 'assistant.run.failed' : 'assistant.run.completed',
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
