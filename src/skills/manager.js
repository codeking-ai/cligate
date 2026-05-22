import { discoverSkillsUnderRoot, loadSkillContent } from './loader.js';
import { resolveSkillRoots } from './roots.js';
import { getSkillSettings, resolveSkillEnabled } from './config.js';
import { SKILL_SCOPE } from './models.js';

function toText(value) {
  return String(value || '').trim();
}

function buildCacheKey({ cwd = '', userHome = '', bundledRoot = '' } = {}) {
  return JSON.stringify({
    cwd: toText(cwd),
    userHome: toText(userHome),
    bundledRoot: toText(bundledRoot)
  });
}

function getScopePriority(scope = '') {
  if (scope === SKILL_SCOPE.REPO) return 3;
  if (scope === SKILL_SCOPE.USER) return 2;
  if (scope === SKILL_SCOPE.BUNDLED) return 1;
  return 0;
}

function dedupeSkills(skills = [], settings = null) {
  const seenPaths = new Set();
  const byName = new Map();
  for (const skill of skills) {
    const pathKey = toText(skill?.pathToSkillMd);
    if (!pathKey || seenPaths.has(pathKey)) {
      continue;
    }
    seenPaths.add(pathKey);
    const normalized = {
      ...skill,
      enabled: resolveSkillEnabled(skill, settings)
    };
    const nameKey = toText(normalized?.name);
    if (!nameKey) {
      byName.set(pathKey, normalized);
      continue;
    }
    const existing = byName.get(nameKey);
    if (!existing || getScopePriority(normalized.scope) > getScopePriority(existing.scope)) {
      byName.set(nameKey, normalized);
    }
  }
  return [...byName.values()].sort((left, right) => (
    `${left.scope}:${left.name}:${left.pathToSkillMd}`.localeCompare(`${right.scope}:${right.name}:${right.pathToSkillMd}`)
  ));
}

export class SkillManager {
  constructor({
    userHome,
    bundledRoot,
    cache = new Map()
  } = {}) {
    this.userHome = userHome;
    this.bundledRoot = bundledRoot;
    this.cache = cache;
  }

  discoverForCwd(cwd = '', options = {}) {
    const cacheKey = buildCacheKey({
      cwd,
      userHome: options.userHome || this.userHome,
      bundledRoot: options.bundledRoot || this.bundledRoot
    });
    if (!options.forceReload && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const roots = resolveSkillRoots({
      cwd,
      userHome: options.userHome || this.userHome,
      bundledRoot: options.bundledRoot || this.bundledRoot
    });
    const settings = options.settings || getSkillSettings();
    const skills = dedupeSkills(roots.flatMap((root) => discoverSkillsUnderRoot(root, options)), settings);
    const result = { roots, skills };
    this.cache.set(cacheKey, result);
    return result;
  }

  getSkillByName({ cwd = '', name = '', forceReload = false } = {}) {
    const discovered = this.discoverForCwd(cwd, { forceReload });
    const normalized = toText(name);
    return discovered.skills.find((skill) => skill.name === normalized) || null;
  }

  loadSkillContent(skill = null) {
    return loadSkillContent(skill);
  }

  clearCache() {
    this.cache.clear();
  }
}

export const skillManager = new SkillManager();

export default skillManager;
