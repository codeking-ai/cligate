import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AssistantMemoryStore } from '../../src/agent-core/memory/memory-store.js';
import { maybeFormFromRun } from '../../src/agent-core/memory/memory-distiller.js';

function freshStore() {
  return new AssistantMemoryStore({ dir: mkdtempSync(join(tmpdir(), 'cligate-distiller-')) });
}

function fakeLlm({ available = true, json = null, raw = null, throwOnComplete = false } = {}) {
  return {
    hasAvailableSource: async () => available,
    complete: async () => {
      if (throwOnComplete) throw new Error('llm boom');
      if (raw != null) return { text: raw };
      return { text: json == null ? '' : JSON.stringify(json) };
    }
  };
}

function makeRun({ status = 'completed', tools = [], triggerText = '登录微信公众平台发文', summary = '已完成' } = {}) {
  return {
    id: 'r1',
    status,
    triggerText,
    summary,
    metadata: {
      toolResults: tools.map((t) => (typeof t === 'string' ? { toolName: t, status: 'completed' } : t))
    }
  };
}

const PROC_TOOLS = ['desktop_launch_app', 'desktop_click_text', 'desktop_type_text'];
const GOOD_JSON = {
  shouldRemember: true,
  kind: 'procedure',
  title: '微信公众平台发文',
  topic: 'mp.weixin.qq.com',
  keywords: ['发文', '推送'],
  recall: 'on-match',
  confidence: 'high',
  body: '## 当前最优步骤\n1. 打开 Chrome\n2. 登录\n## 坑\n- 正文是 iframe'
};

test('skips a run that did not complete', async () => {
  const store = freshStore();
  const res = await maybeFormFromRun({ run: makeRun({ status: 'failed', tools: PROC_TOOLS }), store, llmClient: fakeLlm({ json: GOOD_JSON }) });
  assert.equal(res.formed, false);
  assert.equal(res.reason, 'not_completed');
  assert.equal(store.list().length, 0);
});

test('skips a non-procedural run (read-only desktop tools do not count)', async () => {
  const store = freshStore();
  const run = makeRun({ tools: ['desktop_list_windows', 'desktop_capture_window', 'desktop_health'] });
  const res = await maybeFormFromRun({ run, store, llmClient: fakeLlm({ json: GOOD_JSON }) });
  assert.equal(res.formed, false);
  assert.equal(res.reason, 'not_procedural');
});

test('skips when no LLM source is available', async () => {
  const store = freshStore();
  const res = await maybeFormFromRun({ run: makeRun({ tools: PROC_TOOLS }), store, llmClient: fakeLlm({ available: false }) });
  assert.equal(res.formed, false);
  assert.equal(res.reason, 'no_llm_source');
});

test('forms a memory from a successful procedural run', async () => {
  const store = freshStore();
  const res = await maybeFormFromRun({ run: makeRun({ tools: PROC_TOOLS }), store, llmClient: fakeLlm({ json: GOOD_JSON }) });
  assert.equal(res.formed, true);
  const saved = store.get(res.id);
  assert.equal(saved.kind, 'procedure');
  assert.equal(saved.source, 'auto');
  assert.ok(saved.body.includes('iframe'));
  assert.ok(saved.lastVerified, 'a procedure formed from a verified run gets lastVerified');
});

test('respects the LLM declining (shouldRemember:false)', async () => {
  const store = freshStore();
  const res = await maybeFormFromRun({ run: makeRun({ tools: PROC_TOOLS }), store, llmClient: fakeLlm({ json: { shouldRemember: false } }) });
  assert.equal(res.formed, false);
  assert.equal(res.reason, 'llm_declined');
  assert.equal(store.list().length, 0);
});

test('parses JSON wrapped in a ```json code fence', async () => {
  const store = freshStore();
  const raw = '好的，这是记忆：\n```json\n' + JSON.stringify(GOOD_JSON) + '\n```';
  const res = await maybeFormFromRun({ run: makeRun({ tools: PROC_TOOLS }), store, llmClient: fakeLlm({ raw }) });
  assert.equal(res.formed, true);
});

test('fail-safe: an LLM error never throws, just reports not formed', async () => {
  const store = freshStore();
  const res = await maybeFormFromRun({ run: makeRun({ tools: PROC_TOOLS }), store, llmClient: fakeLlm({ throwOnComplete: true }) });
  assert.equal(res.formed, false);
  assert.equal(res.reason, 'error');
});

test('re-distilling the same task evolves ONE memory in place (verify-then-trust write-back)', async () => {
  const store = freshStore();
  await maybeFormFromRun({ run: makeRun({ tools: PROC_TOOLS }), store, llmClient: fakeLlm({ json: GOOD_JSON }) });
  // A later (corrected) success with the same title/topic should merge, not duplicate.
  const updatedJson = { ...GOOD_JSON, keywords: ['发文', '发表'], body: '## 当前最优步骤\n1. 打开 Chrome\n2. 登录\n3. 发布按钮在「…」菜单' };
  const res2 = await maybeFormFromRun({ run: makeRun({ tools: PROC_TOOLS }), store, llmClient: fakeLlm({ json: updatedJson }) });
  assert.equal(res2.formed, true);
  assert.equal(store.list().length, 1, 'same signature must merge, not duplicate');
  assert.ok(store.get(res2.id).body.includes('「…」菜单'), 'body refreshed to latest known-good');
  assert.deepEqual(store.get(res2.id).keywords.sort(), ['发文', '推送', '发表'].sort(), 'keywords unioned across runs');
});
