import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AssistantMemoryStore, signatureOf } from '../../src/agent-core/memory/memory-store.js';
import { scoreMemory, matchMemories } from '../../src/agent-core/memory/keyword-match.js';
import { buildMemoryRecallContext } from '../../src/agent-core/memory/index.js';

function freshStore() {
  return new AssistantMemoryStore({ dir: mkdtempSync(join(tmpdir(), 'cligate-memory-')) });
}

// --- keyword matcher (pure, no vectors) ------------------------------------

test('scoreMemory: keyword/title/topic substring hits accumulate, no match = 0', () => {
  const memo = { title: '微信公众平台发文', topic: 'mp.weixin.qq.com', keywords: ['发文', '推送', 'publish'] };
  assert.equal(scoreMemory('帮我在微信公众平台发文', memo) >= 3, true); // title(2)+keyword(1)
  assert.equal(scoreMemory('去 mp.weixin.qq.com 推送一篇', memo) >= 4, true); // topic(3)+keyword(1)
  assert.equal(scoreMemory('publish a post', memo), 1); // one keyword
  assert.equal(scoreMemory('今天天气怎么样', memo), 0);
  assert.equal(scoreMemory('', memo), 0);
});

test('matchMemories ranks by score, excludes always-recall, honors minScore + limit', () => {
  const headers = [
    { id: 'a', title: '发文', recall: 'on-match', keywords: ['发文', '微信'], usedCount: 1 },
    { id: 'b', title: '查天气', recall: 'on-match', keywords: ['天气'], usedCount: 9 },
    { id: 'c', title: '永远中文', recall: 'always', keywords: ['发文', '微信', '中文'] }
  ];
  const matched = matchMemories('帮我发文到微信', headers, { limit: 5 });
  assert.deepEqual(matched.map((h) => h.id), ['a']); // b no overlap, c excluded (always)
  // limit honored
  assert.equal(matchMemories('发文 微信 天气', headers, { limit: 1 }).length, 1);
});

// --- store: create / dedup / read-back -------------------------------------

test('upsert creates a normalized memory and get/catalog return it', () => {
  const store = freshStore();
  const saved = store.upsert({ title: 'Test env URL', kind: 'fact', body: 'test = https://test.foo.com' });
  assert.ok(saved.id);
  assert.equal(saved.kind, 'fact');
  assert.equal(saved.recall, 'on-match'); // default
  assert.equal(saved.scope, 'global'); // default
  assert.equal(store.get(saved.id).body, 'test = https://test.foo.com');
  const header = store.catalog()[0];
  assert.equal(header.id, saved.id);
  assert.equal('body' in header, false); // catalog never carries the body
});

test('upsert dedups by signature (kind+topic+title): same task evolves ONE file, keywords unioned', () => {
  const store = freshStore();
  const a = store.upsert({ title: '微信发文', kind: 'procedure', topic: 'mp.weixin.qq.com', keywords: ['发文', '推送'], body: 'v1' });
  const b = store.upsert({ title: '微信发文', kind: 'procedure', topic: 'mp.weixin.qq.com', keywords: ['推送', 'publish'], body: 'v2' });
  assert.equal(a.id, b.id); // same file
  assert.equal(store.list().length, 1);
  assert.deepEqual(store.get(a.id).keywords.sort(), ['publish', '发文', '推送'].sort());
  assert.equal(store.get(a.id).body, 'v2'); // body refreshed
  assert.equal(readdirSync(store.dir).filter((f) => f.endsWith('.md')).length, 1);
});

test('a different topic is a different memory', () => {
  const store = freshStore();
  store.upsert({ title: '发文', kind: 'procedure', topic: 'mp.weixin.qq.com', body: 'x' });
  store.upsert({ title: '发文', kind: 'procedure', topic: 'weibo.com', body: 'y' });
  assert.equal(store.list().length, 2);
});

test('listAlways returns only recall:always; markUsed bumps and persists', () => {
  const store = freshStore();
  const standing = store.upsert({ title: '永远用中文', kind: 'directive', recall: 'always', body: '总是用中文回答' });
  store.upsert({ title: '发文流程', kind: 'procedure', recall: 'on-match', body: '...' });
  assert.deepEqual(store.listAlways().map((r) => r.id), [standing.id]);

  const proc = store.list().find((r) => r.recall === 'on-match');
  store.markUsed(proc.id);
  store.markUsed(proc.id);
  // Re-load from disk to prove persistence.
  const reloaded = new AssistantMemoryStore({ dir: store.dir }).reload();
  assert.equal(reloaded.get(proc.id).usedCount, 2);
  assert.ok(reloaded.get(proc.id).lastUsed);
});

test('memories round-trip through disk (frontmatter parse) and survive a fresh store', () => {
  const store = freshStore();
  const saved = store.upsert({ title: '架构文档位置', kind: 'reference', keywords: ['架构', '文档'], body: 'docs/arch.md' });
  const reopened = new AssistantMemoryStore({ dir: store.dir });
  const got = reopened.get(saved.id);
  assert.equal(got.title, '架构文档位置');
  assert.equal(got.kind, 'reference');
  assert.deepEqual(got.keywords, ['架构', '文档']);
  assert.equal(got.body, 'docs/arch.md');
});

test('upsert rejects an empty title; signatureOf is stable across spacing/case', () => {
  const store = freshStore();
  assert.throws(() => store.upsert({ body: 'x' }), /title/);
  assert.equal(
    signatureOf({ kind: 'Procedure', topic: ' MP.weixin.qq.com ', title: '微信  发文' }),
    signatureOf({ kind: 'procedure', topic: 'mp.weixin.qq.com', title: '微信 发文' })
  );
});

test('delete removes the file and the record', () => {
  const store = freshStore();
  const saved = store.upsert({ title: 'temp', kind: 'fact', body: 'x' });
  assert.equal(store.delete(saved.id), true);
  assert.equal(store.get(saved.id), null);
  assert.equal(readdirSync(store.dir).filter((f) => f.endsWith('.md')).length, 0);
});

test('store ignores unparseable .md files without throwing', () => {
  const store = freshStore();
  store.ensureDir();
  writeFileSync(join(store.dir, 'garbage.md'), 'no frontmatter here', 'utf8');
  store.upsert({ title: 'good', kind: 'fact', body: 'ok' });
  store.reload();
  assert.equal(store.list().length, 1); // only the valid one
});

// --- buildMemoryRecallContext (what observation-service injects) ------------

test('buildMemoryRecallContext returns standing bodies + keyword-matched on-match headers', () => {
  const store = freshStore();
  store.upsert({ title: '永远用中文', kind: 'directive', recall: 'always', body: '总是中文' });
  store.upsert({ title: '微信发文', kind: 'procedure', recall: 'on-match', topic: 'mp.weixin.qq.com', keywords: ['发文', '推送'], body: '步骤...' });
  store.upsert({ title: '查天气', kind: 'procedure', recall: 'on-match', keywords: ['天气'], body: '...' });

  const ctx = buildMemoryRecallContext('帮我在微信公众平台发文', { store });
  assert.equal(ctx.standingMemory.length, 1);
  assert.equal(ctx.standingMemory[0].body, '总是中文'); // standing carries body
  assert.deepEqual(ctx.memoryIndex.map((h) => h.title), ['微信发文']); // 天气 not matched
  assert.equal('body' in ctx.memoryIndex[0], false); // cues carry no body
});

test('buildMemoryRecallContext is fail-safe (returns empty blocks on a broken store)', () => {
  const broken = { listAlways() { throw new Error('boom'); }, catalog() { throw new Error('boom'); } };
  const ctx = buildMemoryRecallContext('anything', { store: broken });
  assert.deepEqual(ctx, { standingMemory: [], memoryIndex: [] });
});
