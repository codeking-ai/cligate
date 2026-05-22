function toText(value) {
  return String(value || '').trim();
}

export const SKILL_SCOPE = Object.freeze({
  REPO: 'repo',
  USER: 'user',
  BUNDLED: 'bundled'
});

export function createSkillMetadata({
  name = '',
  description = '',
  shortDescription = '',
  whenToUse = '',
  tags = [],
  conflictsWith = [],
  pathToSkillMd = '',
  skillDir = '',
  scope = SKILL_SCOPE.REPO,
  rootDir = '',
  enabled = true
} = {}) {
  return {
    name: toText(name),
    description: toText(description),
    shortDescription: toText(shortDescription),
    whenToUse: toText(whenToUse),
    tags: Array.isArray(tags) ? tags.map(toText).filter(Boolean) : [],
    conflictsWith: Array.isArray(conflictsWith) ? conflictsWith.map(toText).filter(Boolean) : [],
    pathToSkillMd: toText(pathToSkillMd),
    skillDir: toText(skillDir),
    scope: toText(scope) || SKILL_SCOPE.REPO,
    rootDir: toText(rootDir),
    enabled: enabled !== false
  };
}

export function createActiveSkill({
  name = '',
  pathToSkillMd = '',
  scope = SKILL_SCOPE.REPO,
  conflictsWith = [],
  content = '',
  activatedAt = '',
  activationSource = 'explicit',
  mode = 'run'
} = {}) {
  return {
    name: toText(name),
    pathToSkillMd: toText(pathToSkillMd),
    scope: toText(scope) || SKILL_SCOPE.REPO,
    conflictsWith: Array.isArray(conflictsWith) ? conflictsWith.map(toText).filter(Boolean) : [],
    content: String(content || ''),
    activatedAt: toText(activatedAt),
    activationSource: toText(activationSource) || 'explicit',
    mode: toText(mode) || 'run'
  };
}

export function createRunSkillState({ available = [], active = [], history = [] } = {}) {
  return {
    available: Array.isArray(available) ? available : [],
    active: Array.isArray(active) ? active : [],
    history: Array.isArray(history) ? history : []
  };
}

export function summarizeSkillMetadata(skill = {}) {
  return {
    name: toText(skill.name),
    description: toText(skill.description),
    shortDescription: toText(skill.shortDescription),
    whenToUse: toText(skill.whenToUse),
    tags: Array.isArray(skill.tags) ? skill.tags.map(toText).filter(Boolean) : [],
    conflictsWith: Array.isArray(skill.conflictsWith) ? skill.conflictsWith.map(toText).filter(Boolean) : [],
    pathToSkillMd: toText(skill.pathToSkillMd),
    scope: toText(skill.scope),
    enabled: skill.enabled !== false
  };
}

export function summarizeActiveSkill(skill = {}) {
  return {
    name: toText(skill.name),
    pathToSkillMd: toText(skill.pathToSkillMd),
    scope: toText(skill.scope),
    conflictsWith: Array.isArray(skill.conflictsWith) ? skill.conflictsWith.map(toText).filter(Boolean) : [],
    activatedAt: toText(skill.activatedAt),
    activationSource: toText(skill.activationSource),
    mode: toText(skill.mode)
  };
}
