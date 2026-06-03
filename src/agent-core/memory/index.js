import assistantMemoryStore, { AssistantMemoryStore, toMemoryHeader, MEMORY_KINDS, MEMORY_RECALL_MODES, signatureOf } from './memory-store.js';
import { matchMemories, scoreMemory } from './keyword-match.js';

function normalizePath(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

// Does a memory's scope apply in the current cwd? `global`/`person` (and unknown)
// recall everywhere — that's the cross-conversation goal (G4). `project:<path>`
// only recalls when the current cwd is in the same project tree, so a project A
// directive/fact never leaks into project B.
export function memoryAppliesToScope(scope = 'global', cwd = '') {
  const s = String(scope || 'global').trim();
  if (!s || s === 'global' || s === 'person') return true;
  if (s.startsWith('project:')) {
    const projectPath = normalizePath(s.slice('project:'.length));
    if (!projectPath) return true;
    const here = normalizePath(cwd);
    if (!here) return false; // no cwd context → don't leak project-scoped memory
    return here === projectPath || here.startsWith(`${projectPath}/`) || projectPath.startsWith(`${here}/`);
  }
  return true; // unknown scope → fail-open (surface rather than hide)
}

// Build the two memory blocks the supervisor prompt consumes, given the incoming
// user text + current cwd. Fail-safe: any error degrades to empty blocks so
// memory never breaks the main conversation flow.
//
//  - standingMemory: `recall: always` memories (directives/facts the user wants
//    applied every turn — like CLAUDE.md). Injected unconditionally, with body.
//  - memoryIndex: keyword-shortlisted `on-match` memory HEADERS (no body). The
//    LLM decides which apply and calls recall_memory(id) to read the body.
// Both are scope-filtered against cwd so project-scoped memories stay in-project.
export function buildMemoryRecallContext(queryText = '', { cwd = '', limit = 5, store = assistantMemoryStore } = {}) {
  try {
    const inScope = store.list().filter((r) => memoryAppliesToScope(r.scope, cwd));
    const standingMemory = inScope
      .filter((r) => r.recall === 'always')
      .map((r) => ({ id: r.id, title: r.title, kind: r.kind, body: r.body }));
    const memoryIndex = matchMemories(queryText, inScope.map(toMemoryHeader), { limit }).map((h) => ({
      id: h.id,
      title: h.title,
      kind: h.kind,
      topic: h.topic,
      confidence: h.confidence,
      usedCount: h.usedCount,
      lastUsed: h.lastUsed,
      keywords: h.keywords
    }));
    return { standingMemory, memoryIndex };
  } catch {
    return { standingMemory: [], memoryIndex: [] };
  }
}

export {
  assistantMemoryStore,
  AssistantMemoryStore,
  toMemoryHeader,
  matchMemories,
  scoreMemory,
  signatureOf,
  MEMORY_KINDS,
  MEMORY_RECALL_MODES
};

export default assistantMemoryStore;
