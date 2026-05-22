import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

import { createSkillMetadata } from './models.js';
import { parseSkillDocument } from './parser.js';

const DEFAULT_MAX_SCAN_DEPTH = 4;
const DEFAULT_MAX_SKILL_DIRS_PER_ROOT = 1000;

function isHiddenName(name = '') {
  return String(name || '').startsWith('.');
}

function safeReadDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function normalizeSingleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function readOptionalFile(path) {
  try {
    if (!existsSync(path)) {
      return '';
    }
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function extractFirstMarkdownHeading(source = '') {
  const match = String(source || '').match(/^\s*#\s+(.+)$/m);
  return normalizeSingleLine(match?.[1] || '');
}

function buildLegacySkillMetadata(skillDir, root) {
  const skillName = basename(skillDir);
  const editingDoc = readOptionalFile(join(skillDir, 'editing.md'));
  const referenceDoc = readOptionalFile(join(skillDir, 'pptxgenjs.md'));
  const shortDescription = extractFirstMarkdownHeading(editingDoc) || extractFirstMarkdownHeading(referenceDoc);
  const description = shortDescription
    ? `${shortDescription} (legacy skill package)`
    : `Legacy skill package "${skillName}" with a non-standard SKILL.md format.`;
  const tags = [];

  if (editingDoc) {
    tags.push('legacy');
    tags.push('workflow');
  }
  if (referenceDoc) {
    tags.push('reference');
  }
  if (safeIsDirectory(join(skillDir, 'scripts'))) {
    tags.push('scripts');
  }

  return createSkillMetadata({
    name: skillName,
    description,
    shortDescription,
    tags: [...new Set(tags)],
    pathToSkillMd: join(skillDir, 'SKILL.md'),
    skillDir,
    scope: root.scope,
    rootDir: root.rootDir,
    enabled: true
  });
}

export function discoverSkillsUnderRoot(root, options = {}) {
  const maxScanDepth = Number(options.maxScanDepth || DEFAULT_MAX_SCAN_DEPTH);
  const maxSkillDirsPerRoot = Number(options.maxSkillDirsPerRoot || DEFAULT_MAX_SKILL_DIRS_PER_ROOT);
  const queue = [{
    dir: resolve(root.rootDir),
    depth: 0
  }];
  const skills = [];
  let scannedDirCount = 0;

  while (queue.length > 0 && scannedDirCount < maxSkillDirsPerRoot) {
    const current = queue.shift();
    if (!current) break;
    if (!safeIsDirectory(current.dir)) continue;
    scannedDirCount += 1;

    const entries = safeReadDir(current.dir);
    const hasSkill = entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md');
    if (hasSkill) {
      const pathToSkillMd = join(current.dir, 'SKILL.md');
      try {
        const source = readFileSync(pathToSkillMd, 'utf8');
        const parsed = parseSkillDocument(source, {
          fallbackName: basename(current.dir)
        });
        skills.push(createSkillMetadata({
          name: parsed.name,
          description: parsed.description,
          shortDescription: parsed.shortDescription,
          whenToUse: parsed.whenToUse,
          tags: parsed.tags,
          conflictsWith: parsed.conflictsWith,
          pathToSkillMd,
          skillDir: dirname(pathToSkillMd),
          scope: root.scope,
          rootDir: root.rootDir,
          enabled: true
        }));
      } catch {
        skills.push(buildLegacySkillMetadata(current.dir, root));
      }
    }

    if (current.depth >= maxScanDepth) {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || isHiddenName(entry.name)) {
        continue;
      }
      queue.push({
        dir: join(current.dir, entry.name),
        depth: current.depth + 1
      });
    }
  }

  return skills;
}

export function loadSkillContent(skill = null) {
  const pathToSkillMd = String(skill?.pathToSkillMd || '').trim();
  if (!pathToSkillMd) {
    throw new Error('skill path is required');
  }
  return readFileSync(pathToSkillMd, 'utf8');
}
