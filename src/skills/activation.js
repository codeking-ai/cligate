import { createActiveSkill, createRunSkillState, summarizeActiveSkill, summarizeSkillMetadata } from './models.js';

function nowIso() {
  return new Date().toISOString();
}

function toText(value) {
  return String(value || '').trim();
}

export function collectExplicitSkillMentions(text = '', availableSkills = []) {
  const source = String(text || '');
  if (!source) return [];
  const wantedNames = [...source.matchAll(/\$([A-Za-z0-9:_-]+)/g)].map((match) => String(match[1] || '').trim());
  if (wantedNames.length === 0) {
    return [];
  }

  const selected = [];
  const seen = new Set();
  for (const name of wantedNames) {
    const skill = availableSkills.find((entry) => entry?.name === name && entry?.enabled !== false);
    if (!skill || seen.has(skill.pathToSkillMd)) {
      continue;
    }
    seen.add(skill.pathToSkillMd);
    selected.push(skill);
  }
  return selected;
}

function tokenize(text = '') {
  return [...new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u3400-\u9fff:_/-]+/g, ' ')
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length >= 2)
  )];
}

function scoreSkillMatch(text = '', skill = {}) {
  const textTokens = tokenize(text);
  if (textTokens.length === 0) return 0;
  const skillTokens = new Set([
    ...tokenize(skill?.name || ''),
    ...tokenize(skill?.description || ''),
    ...tokenize(skill?.shortDescription || ''),
    ...tokenize(skill?.whenToUse || ''),
    ...(Array.isArray(skill?.tags) ? skill.tags.flatMap((tag) => tokenize(tag)) : [])
  ]);
  if (skillTokens.size === 0) return 0;
  const overlap = textTokens.filter((token) => skillTokens.has(token)).length;
  const exactName = skill?.name && String(text || '').toLowerCase().includes(String(skill.name).toLowerCase());
  const exactDescription = skill?.description && String(text || '').toLowerCase().includes(String(skill.description).toLowerCase());
  const exactWhenToUse = skill?.whenToUse && String(text || '').toLowerCase().includes(String(skill.whenToUse).toLowerCase());
  return overlap + (exactName ? 3 : 0) + (exactDescription ? 2 : 0) + (exactWhenToUse ? 2 : 0);
}

export function collectSuggestedSkills(text = '', availableSkills = [], { maxCount = 2, minScore = 2 } = {}) {
  const scored = (Array.isArray(availableSkills) ? availableSkills : [])
    .filter((entry) => entry?.enabled !== false)
    .map((skill) => ({
      skill,
      score: scoreSkillMatch(text, skill)
    }))
    .filter((entry) => entry.score >= minScore)
    .sort((left, right) => right.score - left.score);
  const selected = [];
  for (const entry of scored) {
    if (selected.length >= Math.max(1, Number(maxCount || 1))) {
      break;
    }
    if (selected.some((existing) => skillsConflict(existing, entry.skill))) {
      continue;
    }
    selected.push(entry.skill);
  }
  return selected;
}

export function shouldReplaceActiveSkills(text = '', activeSkills = [], availableSkills = []) {
  const current = Array.isArray(activeSkills) ? activeSkills : [];
  if (current.length === 0) {
    return false;
  }
  const explicit = collectExplicitSkillMentions(text, availableSkills);
  if (explicit.length > 0) {
    const explicitPaths = new Set(explicit.map((entry) => toText(entry?.pathToSkillMd)).filter(Boolean));
    return current.some((entry) => !explicitPaths.has(toText(entry?.pathToSkillMd)));
  }
  const suggested = collectSuggestedSkills(text, availableSkills);
  if (suggested.length === 0) {
    return false;
  }
  const suggestedPaths = new Set(suggested.map((entry) => toText(entry?.pathToSkillMd)).filter(Boolean));
  return current.some((entry) => !suggestedPaths.has(toText(entry?.pathToSkillMd)));
}

export function activateSkillsForRun({
  run = null,
  availableSkills = [],
  selectedSkills = [],
  loadSkillContent
} = {}) {
  const currentState = createRunSkillState(run?.metadata?.skills || {});
  const active = [...currentState.active];
  const history = [...currentState.history];

  for (const skill of selectedSkills) {
    if (active.some((entry) => skillsConflict(entry, skill))) {
      continue;
    }
    const existing = active.find((entry) => toText(entry.pathToSkillMd) === toText(skill.pathToSkillMd));
    if (existing) {
      continue;
    }
    const content = loadSkillContent(skill);
    const activeSkill = createActiveSkill({
      name: skill.name,
      pathToSkillMd: skill.pathToSkillMd,
      scope: skill.scope,
      conflictsWith: skill.conflictsWith,
      content,
      activatedAt: nowIso(),
      activationSource: 'explicit',
      mode: 'run'
    });
    active.push(activeSkill);
    history.push(summarizeActiveSkill(activeSkill));
  }

  return createRunSkillState({
    available: availableSkills.map(summarizeSkillMetadata),
    active,
    history
  });
}

export function skillsConflict(left = null, right = null) {
  const leftName = toText(left?.name);
  const rightName = toText(right?.name);
  if (!leftName || !rightName || leftName === rightName) {
    return false;
  }
  const leftConflicts = new Set(Array.isArray(left?.conflictsWith) ? left.conflictsWith.map(toText).filter(Boolean) : []);
  const rightConflicts = new Set(Array.isArray(right?.conflictsWith) ? right.conflictsWith.map(toText).filter(Boolean) : []);
  return leftConflicts.has(rightName) || rightConflicts.has(leftName);
}

export function buildSkillAwareRuntimeInput(task = '', activeSkills = []) {
  const source = String(task || '').trim();
  const mounted = Array.isArray(activeSkills) ? activeSkills.filter(Boolean) : [];
  if (!mounted.length) {
    return source;
  }
  return [
    source,
    '',
    '<active_skills>',
    'The following skills are active for this run. Follow them while completing this task.',
    ...mounted.flatMap((skill) => ([
      '<skill>',
      `<name>${skill.name}</name>`,
      `<path>${skill.pathToSkillMd}</path>`,
      skill.content || '',
      '</skill>'
    ])),
    '</active_skills>'
  ].join('\n');
}

export function restoreActiveSkillsFromCheckpoint(run = null) {
  const metadataSkills = run?.metadata?.skills || {};
  const checkpointSkills = run?.metadata?.checkpoint?.skills || {};
  const active = Array.isArray(metadataSkills.active) && metadataSkills.active.length > 0
    ? metadataSkills.active
    : (Array.isArray(checkpointSkills.active) ? checkpointSkills.active : []);
  const history = Array.isArray(metadataSkills.history) && metadataSkills.history.length > 0
    ? metadataSkills.history
    : (Array.isArray(checkpointSkills.history) ? checkpointSkills.history : []);

  return createRunSkillState({
    available: Array.isArray(metadataSkills.available) ? metadataSkills.available : [],
    active,
    history
  });
}

export function expireInactiveSkills(run = null, {
  keepNames = [],
  keepPaths = []
} = {}) {
  const state = restoreActiveSkillsFromCheckpoint(run);
  const keepNameSet = new Set((Array.isArray(keepNames) ? keepNames : []).map((entry) => toText(entry)).filter(Boolean));
  const keepPathSet = new Set((Array.isArray(keepPaths) ? keepPaths : []).map((entry) => toText(entry)).filter(Boolean));
  return createRunSkillState({
    available: state.available,
    active: state.active.filter((skill) => (
      keepNameSet.has(toText(skill?.name))
      || keepPathSet.has(toText(skill?.pathToSkillMd))
    )),
    history: state.history
  });
}

export function replaceActiveSkills(run = null, nextActiveSkills = []) {
  const state = restoreActiveSkillsFromCheckpoint(run);
  const next = Array.isArray(nextActiveSkills) ? nextActiveSkills : [];
  return createRunSkillState({
    available: state.available,
    active: next,
    history: [
      ...state.history,
      ...next.map(summarizeActiveSkill)
    ]
  });
}
