// Pure, dependency-free keyword matcher for assistant memory recall.
//
// Deliberately NOT semantic/vector-based — mirrors how Codex / Claude Code
// surface skills and files: cheap lexical matching to produce a *candidate
// shortlist*, then the supervisor LLM itself decides which memory actually
// applies. The intelligence lives in (a) the LLM-authored keyword/alias list on
// each memory and (b) the LLM's own judgement at recall time — not here.
//
// No tokenizer is needed: Chinese is matched by substring containment, which is
// exactly what we want when memories carry explicit keyword phrases.

function normalize(value) {
  return String(value || '').toLowerCase();
}

// Score one memory header against the incoming query text. Higher = more likely
// relevant. Returns 0 when nothing matches.
export function scoreMemory(queryText, header = {}) {
  const q = normalize(queryText);
  if (!q) return 0;

  let score = 0;

  // Keyword (incl. synonyms/aliases the memory author wrote) substring hits.
  const keywords = Array.isArray(header.keywords) ? header.keywords : [];
  for (const kw of keywords) {
    const k = normalize(kw);
    if (k && q.includes(k)) score += 1;
  }

  // The whole title appearing verbatim is a strong signal.
  const title = normalize(header.title);
  if (title && q.includes(title)) score += 2;

  // The structured topic (site/app/project) is the highest-precision key.
  const topic = normalize(header.topic);
  if (topic && q.includes(topic)) score += 3;

  return score;
}

// Rank on-match memories by relevance to the query. `always`-recall memories are
// excluded — they're injected unconditionally elsewhere, not via this shortlist.
export function matchMemories(queryText, headers = [], { limit = 5, minScore = 1 } = {}) {
  if (!Array.isArray(headers) || headers.length === 0) return [];
  return headers
    .filter((h) => h && String(h.recall || 'on-match') !== 'always')
    .map((h) => ({ header: h, score: scoreMemory(queryText, h) }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => (b.score - a.score) || (Number(b.header.usedCount || 0) - Number(a.header.usedCount || 0)))
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.header);
}

export default matchMemories;
