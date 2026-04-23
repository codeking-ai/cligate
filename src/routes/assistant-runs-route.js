import assistantRunStore from '../assistant-core/run-store.js';
import AssistantRunner from '../assistant-core/runner.js';

function parseLimit(value, fallback = 20, max = 200) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function handleListAssistantRuns(req, res) {
  const assistantSessionId = String(req.query.assistantSessionId || '');
  const conversationId = String(req.query.conversationId || '');
  const limit = parseLimit(req.query.limit, 20, 100);

  const runs = conversationId
    ? assistantRunStore.listByConversationId(conversationId, { limit })
    : assistantRunStore.list({ assistantSessionId, limit });

  return res.json({
    success: true,
    runs
  });
}

export function handleGetAssistantRun(req, res) {
  const run = assistantRunStore.get(String(req.params.id || ''));
  if (!run) {
    return res.status(404).json({
      success: false,
      error: 'assistant run not found'
    });
  }

  return res.json({
    success: true,
    run
  });
}

export async function handleResumeAssistantRun(req, res) {
  const runId = String(req.params.id || '');
  const run = assistantRunStore.get(runId);
  if (!run) {
    return res.status(404).json({
      success: false,
      error: 'assistant run not found'
    });
  }
  if (!assistantRunStore.canResume(runId)) {
    return res.status(400).json({
      success: false,
      error: 'assistant run is not resumable'
    });
  }

  try {
    const runner = new AssistantRunner({
      runStore: assistantRunStore
    });
    const executed = await runner.run({
      run,
      conversation: run.conversationId ? { id: run.conversationId } : null,
      text: run.triggerText || '',
      defaultRuntimeProvider: run?.metadata?.agent?.defaultRuntimeProvider || 'codex',
      cwd: run?.metadata?.agent?.cwd || run?.metadata?.plan?.cwd || '',
      model: run?.metadata?.agent?.requestedModel || '',
      resume: true
    });

    return res.json({
      success: true,
      run: executed.run,
      resumed: true
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'assistant run resume failed'
    });
  }
}

export default {
  handleListAssistantRuns,
  handleGetAssistantRun,
  handleResumeAssistantRun
};
