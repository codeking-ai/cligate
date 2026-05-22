import { existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';

import { SKILL_SCOPE } from './models.js';

function toText(value) {
  return String(value || '').trim();
}

function uniqueRoots(entries = []) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const rootDir = toText(entry?.rootDir);
    if (!rootDir || seen.has(rootDir)) {
      continue;
    }
    seen.add(rootDir);
    result.push({
      scope: entry.scope,
      rootDir
    });
  }
  return result;
}

export function resolveRepoSkillRoots(cwd = '', { projectMarkers = ['package.json', '.git'] } = {}) {
  const start = toText(cwd);
  if (!start) return [];
  const roots = [];
  let current = resolve(start);
  const startResolved = resolve(start);
  const startHasMarker = projectMarkers.some((marker) => existsSync(join(startResolved, marker)));

  while (true) {
    const skillRoot = join(current, '.cligate', 'skills');
    if (existsSync(skillRoot)) {
      roots.push({
        scope: SKILL_SCOPE.REPO,
        rootDir: skillRoot
      });
    }

    const parent = dirname(current);
    const hasMarker = projectMarkers.some((marker) => existsSync(join(current, marker)));
    if (hasMarker && current !== startResolved) {
      break;
    }
    if (current === startResolved && startHasMarker) {
      break;
    }
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return roots;
}

export function resolveSkillRoots({
  cwd = '',
  userHome = homedir(),
  bundledRoot = join(process.cwd(), 'src', 'bundled-skills'),
  includeRepoRoots = true
} = {}) {
  const roots = [
    ...(includeRepoRoots ? resolveRepoSkillRoots(cwd) : []),
    {
      scope: SKILL_SCOPE.USER,
      rootDir: join(toText(userHome), '.cligate', 'skills')
    },
    {
      scope: SKILL_SCOPE.BUNDLED,
      rootDir: bundledRoot
    }
  ];

  return uniqueRoots(roots);
}
