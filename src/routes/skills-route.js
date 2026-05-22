import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { execFileSync } from 'child_process';

import {
  skillManager,
  getSkillSettings,
  setSkillEnabled,
  setSkillSettings,
  parseSkillDocument,
  resolveSkillRoots,
  SKILL_SCOPE
} from '../skills/index.js';

function toText(value) {
  return String(value || '').trim();
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map(toText).filter(Boolean);
  }
  return String(value || '')
    .split(/\r?\n|,/)
    .map(toText)
    .filter(Boolean);
}

function yamlQuote(value) {
  return JSON.stringify(String(value || ''));
}

function ensureInsideRoot(targetPath, rootDir) {
  const absoluteTarget = resolve(targetPath);
  const absoluteRoot = resolve(rootDir);
  const rel = relative(absoluteRoot, absoluteTarget);
  return rel === '' || (!rel.startsWith('..') && !rel.includes(':'));
}

function resolveRepoRootForCreation(cwd = '') {
  const normalizedCwd = toText(cwd);
  if (!normalizedCwd) {
    throw new Error('cwd is required for repo skills');
  }
  const roots = resolveSkillRoots({ cwd: normalizedCwd }).filter((entry) => entry.scope === SKILL_SCOPE.REPO);
  if (roots.length > 0) {
    return roots[0].rootDir;
  }
  return join(resolve(normalizedCwd), '.cligate', 'skills');
}

function resolveWritableSkillRoot({ cwd = '', scope = SKILL_SCOPE.REPO } = {}) {
  if (scope === SKILL_SCOPE.USER) {
    const roots = resolveSkillRoots({ cwd }).filter((entry) => entry.scope === SKILL_SCOPE.USER);
    return roots[0]?.rootDir || join(process.env.USERPROFILE || process.env.HOME || '', '.cligate', 'skills');
  }
  if (scope === SKILL_SCOPE.REPO) {
    return resolveRepoRootForCreation(cwd);
  }
  throw new Error('only assistant-installed and legacy repo scopes are writable');
}

function getWritableSkillRecord({ cwd = '', path = '' } = {}) {
  const normalizedPath = toText(path);
  if (!normalizedPath) {
    throw new Error('path is required');
  }
  const discovered = skillManager.discoverForCwd(cwd, { forceReload: true });
  const skill = discovered.skills.find((entry) => toText(entry?.pathToSkillMd) === normalizedPath) || null;
  if (!skill) {
    throw new Error('skill not found');
  }
  if (skill.scope === SKILL_SCOPE.BUNDLED) {
    throw new Error('bundled skills are read-only');
  }
  if (!ensureInsideRoot(skill.pathToSkillMd, skill.rootDir || dirname(skill.pathToSkillMd))) {
    throw new Error('skill path is outside the allowed root');
  }
  return skill;
}

function buildSkillDocument({
  name = '',
  description = '',
  shortDescription = '',
  whenToUse = '',
  tags = [],
  conflictsWith = [],
  body = ''
} = {}) {
  const lines = [
    '---',
    `name: ${yamlQuote(name)}`,
    `description: ${yamlQuote(description)}`
  ];
  const normalizedShortDescription = toText(shortDescription);
  if (normalizedShortDescription) {
    lines.push('metadata:');
    lines.push(`  short_description: ${yamlQuote(normalizedShortDescription)}`);
  }
  const normalizedWhenToUse = toText(whenToUse);
  if (normalizedWhenToUse) {
    lines.push(`when_to_use: ${yamlQuote(normalizedWhenToUse)}`);
  }
  const normalizedTags = normalizeStringList(tags);
  if (normalizedTags.length > 0) {
    lines.push('tags:');
    for (const tag of normalizedTags) {
      lines.push(`  - ${yamlQuote(tag)}`);
    }
  }
  const normalizedConflicts = normalizeStringList(conflictsWith);
  if (normalizedConflicts.length > 0) {
    lines.push('conflicts_with:');
    for (const nameEntry of normalizedConflicts) {
      lines.push(`  - ${yamlQuote(nameEntry)}`);
    }
  }
  lines.push('---');
  lines.push(String(body || '').replace(/^\n+/, ''));
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function buildSkillDetail(skill, rawContent = '') {
  let parsed = null;
  try {
    parsed = parseSkillDocument(rawContent, {
      fallbackName: skill?.name || ''
    });
  } catch {
    parsed = {
      name: skill?.name || '',
      description: skill?.description || '',
      shortDescription: skill?.shortDescription || '',
      whenToUse: skill?.whenToUse || '',
      tags: Array.isArray(skill?.tags) ? skill.tags : [],
      conflictsWith: Array.isArray(skill?.conflictsWith) ? skill.conflictsWith : [],
      body: ''
    };
  }
  return {
    ...skill,
    shortDescription: parsed.shortDescription,
    whenToUse: parsed.whenToUse,
    tags: parsed.tags,
    conflictsWith: parsed.conflictsWith,
    body: parsed.body,
    rawContent
  };
}

function sanitizeSkillDirName(value = '') {
  return toText(value)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function sanitizeRelativeImportPath(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..');
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function detectSkillDirFromTree(rootDir) {
  const directSkill = join(rootDir, 'SKILL.md');
  if (existsSync(directSkill)) {
    return rootDir;
  }
  const entries = existsSync(rootDir) ? readdirSync(rootDir, { withFileTypes: true }) : [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = join(rootDir, entry.name, 'SKILL.md');
    if (existsSync(nested)) {
      return join(rootDir, entry.name);
    }
  }
  return '';
}

function copyImportedFiles(targetDir, files = []) {
  for (const file of files) {
    const relativePathParts = sanitizeRelativeImportPath(file?.relativePath || file?.path || '');
    if (relativePathParts.length === 0) {
      continue;
    }
    const targetPath = join(targetDir, ...relativePathParts);
    if (!ensureInsideRoot(targetPath, targetDir)) {
      throw new Error('import contains a path outside the skill directory');
    }
    ensureDirectory(dirname(targetPath));
    if (String(file?.encoding || '').toLowerCase() === 'base64') {
      writeFileSync(targetPath, Buffer.from(String(file.content || ''), 'base64'));
      continue;
    }
    writeFileSync(targetPath, String(file?.content || ''), 'utf8');
  }
}

function listRelativeFiles(rootDir, currentDir = rootDir, acc = []) {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(currentDir, entry.name);
    const relativePath = relative(rootDir, absolute).split(sep).join('/');
    if (entry.isDirectory()) {
      listRelativeFiles(rootDir, absolute, acc);
      continue;
    }
    acc.push(relativePath);
  }
  return acc;
}

function extractZipToTemp(zipBuffer) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cligate-skill-import-'));
  const zipPath = join(tempRoot, 'skill.zip');
  const extractDir = join(tempRoot, 'extracted');
  ensureDirectory(extractDir);
  writeFileSync(zipPath, zipBuffer);

  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
    ], { stdio: 'pipe' });
    return { tempRoot, extractDir };
  }

  execFileSync('unzip', ['-qq', zipPath, '-d', extractDir], { stdio: 'pipe' });
  return { tempRoot, extractDir };
}

function importSkillFromDirectoryFiles({
  cwd = '',
  scope = SKILL_SCOPE.REPO,
  rootName = '',
  files = []
} = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('files are required');
  }
  const stagingRoot = mkdtempSync(join(tmpdir(), 'cligate-skill-files-'));
  try {
    copyImportedFiles(stagingRoot, files);

    const detectedSkillDir = detectSkillDirFromTree(stagingRoot);
    if (!detectedSkillDir) {
      throw new Error('imported package must contain SKILL.md');
    }

    const skillName = sanitizeSkillDirName(basename(detectedSkillDir) || rootName || 'imported-skill');
    if (!skillName) {
      throw new Error('skill directory name is invalid');
    }

    const rootDir = resolveWritableSkillRoot({ cwd, scope });
    const finalSkillDir = join(rootDir, skillName);
    if (existsSync(finalSkillDir)) {
      throw new Error(`skill already exists: ${skillName}`);
    }

    ensureDirectory(finalSkillDir);
    const stagedFiles = listRelativeFiles(detectedSkillDir).map((relativePath) => ({
      relativePath,
      encoding: 'base64',
      content: readFileSync(join(detectedSkillDir, relativePath)).toString('base64')
    }));
    copyImportedFiles(finalSkillDir, stagedFiles);

    const skillPath = join(finalSkillDir, 'SKILL.md');
    const rawContent = readFileSync(skillPath, 'utf8');
    parseSkillDocument(rawContent, { fallbackName: skillName });
    return { skillDir: finalSkillDir, skillPath, rootDir };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function importSkillFromZip({
  cwd = '',
  scope = SKILL_SCOPE.REPO,
  fileName = '',
  contentBase64 = ''
} = {}) {
  if (!contentBase64) {
    throw new Error('zip content is required');
  }
  const extracted = extractZipToTemp(Buffer.from(contentBase64, 'base64'));
  try {
    const detectedSkillDir = detectSkillDirFromTree(extracted.extractDir);
    if (!detectedSkillDir) {
      throw new Error('zip package must contain SKILL.md');
    }
    const relativeFiles = listRelativeFiles(detectedSkillDir).map((relativePath) => {
      const absolute = join(detectedSkillDir, relativePath);
      return {
        relativePath,
        encoding: 'base64',
        content: readFileSync(absolute).toString('base64')
      };
    });
    const suggestedName = sanitizeSkillDirName(fileName.replace(/\.zip$/i, '')) || basename(detectedSkillDir);
    return importSkillFromDirectoryFiles({
      cwd,
      scope,
      rootName: suggestedName,
      files: relativeFiles
    });
  } finally {
    rmSync(extracted.tempRoot, { recursive: true, force: true });
  }
}

export function handleListSkills(req, res) {
  const cwd = String(req.query.cwd || process.cwd()).trim();
  const discovered = skillManager.discoverForCwd(cwd, {
    forceReload: req.query.forceReload === '1' || req.query.forceReload === 'true'
  });
  const skills = discovered.skills || [];
  return res.json({
    success: true,
    cwd,
    skills,
    installedSkills: skills.filter((entry) => entry.scope === SKILL_SCOPE.USER),
    legacyRepoSkills: skills.filter((entry) => entry.scope === SKILL_SCOPE.REPO),
    bundledSkills: skills.filter((entry) => entry.scope === SKILL_SCOPE.BUNDLED),
    roots: discovered.roots,
    settings: getSkillSettings()
  });
}

export function handleGetSkillSettings(req, res) {
  return res.json({
    success: true,
    skills: getSkillSettings()
  });
}

export function handleUpdateSkillSettings(req, res) {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({
      success: false,
      error: 'enabled must be a boolean'
    });
  }
  const current = getSkillSettings();
  const skills = setSkillSettings({
    ...current,
    enabled
  });
  skillManager.clearCache();
  return res.json({
    success: true,
    skills
  });
}

export function handleSetSkillEnabled(req, res) {
  const path = String(req.body?.path || '').trim();
  const name = String(req.body?.name || '').trim();
  const enabled = req.body?.enabled;
  if (!path && !name) {
    return res.status(400).json({
      success: false,
      error: 'path or name is required'
    });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({
      success: false,
      error: 'enabled must be a boolean'
    });
  }
  try {
    const skills = setSkillEnabled({ path, name, enabled });
    skillManager.clearCache();
    return res.json({
      success: true,
      skills
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error?.message || 'failed to update skill settings'
    });
  }
}

export function handleGetSkillContent(req, res) {
  const cwd = toText(req.query.cwd || process.cwd());
  const path = toText(req.query.path || '');
  if (!path) {
    return res.status(400).json({
      success: false,
      error: 'path is required'
    });
  }
  try {
    const skill = getWritableSkillRecord({ cwd, path });
    const rawContent = readFileSync(skill.pathToSkillMd, 'utf8');
    return res.json({
      success: true,
      skill: buildSkillDetail(skill, rawContent)
    });
  } catch (error) {
    if (existsSync(path)) {
      const discovered = skillManager.discoverForCwd(cwd, { forceReload: true });
      const bundledSkill = discovered.skills.find((entry) => toText(entry.pathToSkillMd) === path);
      if (bundledSkill) {
        const rawContent = readFileSync(bundledSkill.pathToSkillMd, 'utf8');
        return res.json({
          success: true,
          skill: buildSkillDetail(bundledSkill, rawContent)
        });
      }
    }
    return res.status(400).json({
      success: false,
      error: error?.message || 'failed to load skill content'
    });
  }
}

export function handleCreateSkill(req, res) {
  const cwd = toText(req.body?.cwd || process.cwd());
  const scope = toText(req.body?.scope || SKILL_SCOPE.REPO) || SKILL_SCOPE.REPO;
  const name = toText(req.body?.name || '');
  const description = toText(req.body?.description || '');
  const shortDescription = toText(req.body?.shortDescription || '');
  const whenToUse = toText(req.body?.whenToUse || '');
  const body = String(req.body?.body || '').trim();
  if (!name) {
    return res.status(400).json({ success: false, error: 'name is required' });
  }
  if (!description) {
    return res.status(400).json({ success: false, error: 'description is required' });
  }
  if (!body) {
    return res.status(400).json({ success: false, error: 'body is required' });
  }
  try {
    const rootDir = resolveWritableSkillRoot({ cwd, scope });
    const dirName = sanitizeSkillDirName(req.body?.directoryName || name);
    if (!dirName) {
      throw new Error('directory name is invalid');
    }
    const skillDir = join(rootDir, dirName);
    const skillPath = join(skillDir, 'SKILL.md');
    if (existsSync(skillPath)) {
      throw new Error('skill already exists');
    }
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, buildSkillDocument({
      name,
      description,
      shortDescription,
      whenToUse,
      tags: req.body?.tags,
      conflictsWith: req.body?.conflictsWith,
      body
    }), 'utf8');
    skillManager.clearCache();
    const discovered = skillManager.discoverForCwd(cwd, { forceReload: true });
    const created = discovered.skills.find((entry) => toText(entry.pathToSkillMd) === skillPath) || null;
    return res.json({
      success: true,
      skill: created
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error?.message || 'failed to create skill'
    });
  }
}

export function handleUpdateSkill(req, res) {
  const cwd = toText(req.body?.cwd || process.cwd());
  const path = toText(req.body?.path || '');
  const name = toText(req.body?.name || '');
  const description = toText(req.body?.description || '');
  const body = String(req.body?.body || '').trim();
  if (!path) {
    return res.status(400).json({ success: false, error: 'path is required' });
  }
  if (!name) {
    return res.status(400).json({ success: false, error: 'name is required' });
  }
  if (!description) {
    return res.status(400).json({ success: false, error: 'description is required' });
  }
  if (!body) {
    return res.status(400).json({ success: false, error: 'body is required' });
  }
  try {
    const skill = getWritableSkillRecord({ cwd, path });
    writeFileSync(skill.pathToSkillMd, buildSkillDocument({
      name,
      description,
      shortDescription: req.body?.shortDescription,
      whenToUse: req.body?.whenToUse,
      tags: req.body?.tags,
      conflictsWith: req.body?.conflictsWith,
      body
    }), 'utf8');
    skillManager.clearCache();
    const discovered = skillManager.discoverForCwd(cwd, { forceReload: true });
    const updated = discovered.skills.find((entry) => toText(entry.pathToSkillMd) === skill.pathToSkillMd) || null;
    return res.json({
      success: true,
      skill: updated
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error?.message || 'failed to update skill'
    });
  }
}

export function handleDeleteSkill(req, res) {
  const cwd = toText(req.body?.cwd || process.cwd());
  const path = toText(req.body?.path || '');
  if (!path) {
    return res.status(400).json({ success: false, error: 'path is required' });
  }
  try {
    const skill = getWritableSkillRecord({ cwd, path });
    if (!ensureInsideRoot(skill.skillDir, skill.rootDir)) {
      throw new Error('skill directory is outside the allowed root');
    }
    rmSync(skill.skillDir, { recursive: true, force: false });
    skillManager.clearCache();
    return res.json({
      success: true,
      path: skill.pathToSkillMd
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error?.message || 'failed to delete skill'
    });
  }
}

export function handleImportSkill(req, res) {
  const cwd = toText(req.body?.cwd || process.cwd());
  const scope = SKILL_SCOPE.USER;
  const mode = toText(req.body?.mode || '');

  try {
    let imported = null;
    if (mode === 'directory') {
      imported = importSkillFromDirectoryFiles({
        cwd,
        scope,
        rootName: toText(req.body?.rootName || ''),
        files: Array.isArray(req.body?.files) ? req.body.files : []
      });
    } else if (mode === 'zip') {
      imported = importSkillFromZip({
        cwd,
        scope,
        fileName: toText(req.body?.fileName || 'skill.zip'),
        contentBase64: String(req.body?.contentBase64 || '')
      });
    } else {
      throw new Error('mode must be directory or zip');
    }

    skillManager.clearCache();
    const discovered = skillManager.discoverForCwd(cwd, { forceReload: true });
    const created = discovered.skills.find((entry) => toText(entry.pathToSkillMd) === imported.skillPath) || null;
    return res.json({
      success: true,
      skill: created
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error?.message || 'failed to import skill'
    });
  }
}

export default {
  handleListSkills,
  handleGetSkillSettings,
  handleUpdateSkillSettings,
  handleSetSkillEnabled,
  handleGetSkillContent,
  handleCreateSkill,
  handleUpdateSkill,
  handleDeleteSkill,
  handleImportSkill
};
