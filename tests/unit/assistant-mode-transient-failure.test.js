import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import AssistantModeService from '../../src/assistant-core/mode-service.js';

// finalizeRunFailure is the single point where a failed assistant run becomes
// the user-facing reply (channel + web both read result.message). For transient
// upstream/network failures (ECONNRESET / "fetch failed" / timeouts) it should
// return a friendly, language-matched notice instead of the raw transport error
// — while keeping the real error verbatim in the run summary/metadata.
function buildService() {
  const savedRuns = [];
  const runEvents = [];
  const svc = new AssistantModeService({
    conversationStore: { patch: (id, patch) => ({ id, ...patch }) },
    assistantSessionStore: { save: (s) => s, get: () => null },
    assistantRunStore: {
      save: (r) => { savedRuns.push(r); return r; },
      get: () => null
    },
    observationService: {},
    messageService: {},
    taskViewService: {},
    supervisorTaskStore: {},
    runner: {},
    dialogueService: {},
    runEventStore: { append: (id, evt) => { runEvents.push({ id, evt }); } }
  });
  return { svc, savedRuns, runEvents };
}

function failWith({ error, runText }) {
  const { svc, savedRuns } = buildService();
  return svc.finalizeRunFailure({
    conversation: { id: 'conv-1', metadata: { assistantCore: {} } },
    assistantSession: { id: 'sess-1' },
    runText,
    run: { id: 'run-1', metadata: {} },
    error,
    assistantModeActive: true
  }).then((result) => ({ result, savedRuns }));
}

test('transient network failure returns a friendly Chinese notice when the user wrote Chinese', async () => {
  const { result, savedRuns } = await failWith({
    error: new Error('fetch failed'),
    runText: '请你将图片发回给我'
  });
  assert.equal(result.isError, true);
  assert.match(result.message, /网络|连接被重置|稍后/);
  assert.doesNotMatch(result.message, /fetch failed/i);
  // The raw error is still preserved for diagnostics (run summary/metadata).
  assert.ok(savedRuns.some((r) => String(r.summary || '').includes('fetch failed')
    || String(r.metadata?.error || '').includes('fetch failed')));
});

test('transient network failure returns a friendly English notice when the user wrote English', async () => {
  const { result } = await failWith({
    error: Object.assign(new Error('request failed'), { code: 'ECONNRESET' }),
    runText: 'please send me the image'
  });
  assert.equal(result.isError, true);
  assert.match(result.message, /network|connection|try again/i);
  assert.doesNotMatch(result.message, /ECONNRESET|fetch failed/i);
});

test('non-transient failures still surface the real error message verbatim', async () => {
  const { result } = await failWith({
    error: new Error('INVALID_REQUEST: model not supported'),
    runText: '随便做点什么'
  });
  assert.equal(result.isError, true);
  assert.equal(result.message, 'INVALID_REQUEST: model not supported');
});
