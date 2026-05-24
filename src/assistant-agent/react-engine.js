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

export class AssistantReactEngine {
  constructor({
    llmClient,
    toolRegistry,
    toolExecutor,
    reflectionService = assistantReflectionService,
    maxIterations = 6
  } = {}) {
    this.llmClient = llmClient;
    this.toolRegistry = toolRegistry;
    this.toolExecutor = toolExecutor;
    this.reflectionService = reflectionService instanceof AssistantReflectionService
      ? reflectionService
      : reflectionService;
    this.maxIterations = maxIterations;
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

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      const completion = await this.llmClient.complete({
        system: prompt.system,
        messages: transcript,
        tools: toolDefinitions,
        model
      });
      llmSource = completion.source;
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

      for (const toolCall of completion.toolCalls) {
        const result = await this.toolExecutor.executeToolCall({
          toolName: toolCall.name,
          input: toolCall.input || {}
        }, {
          run: workingRun,
          conversation,
          cwd
        });
        toolResults.push(result);
        workingRun.steps.push(summarizeToolStep(toolCall.name, result));

        const session = extractToolResultSession(result);
        if (session?.id && session?.provider) {
          relatedRuntimeSessionIds.add(session.id);
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
      maxIterationsReached
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
