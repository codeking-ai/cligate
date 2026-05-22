import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  parseSkillDocument,
  resolveSkillRoots,
  SkillManager,
  renderAvailableSkills,
  renderActiveSkills,
  collectExplicitSkillMentions,
  collectSuggestedSkills,
  shouldReplaceActiveSkills,
  activateSkillsForRun,
  restoreActiveSkillsFromCheckpoint,
  buildSkillAwareRuntimeInput,
  expireInactiveSkills,
  replaceActiveSkills,
  setSkillEnabled
} from '../../src/skills/index.js';

function makeTempDir(prefix = 'cligate-skills-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSkill(rootDir, skillName, body) {
  const skillDir = join(rootDir, skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), body, 'utf8');
  return join(skillDir, 'SKILL.md');
}

test('parseSkillDocument reads frontmatter and body', () => {
  const parsed = parseSkillDocument(`---
name: demo
description: Demo skill
metadata:
  short_description: Short demo
when_to_use: Use when investigating a repo
tags: [repo, investigation]
conflicts_with: [quick-fix]
---
Step 1
Step 2
`);

  assert.equal(parsed.name, 'demo');
  assert.equal(parsed.description, 'Demo skill');
  assert.equal(parsed.shortDescription, 'Short demo');
  assert.equal(parsed.whenToUse, 'Use when investigating a repo');
  assert.deepEqual(parsed.tags, ['repo', 'investigation']);
  assert.deepEqual(parsed.conflictsWith, ['quick-fix']);
  assert.match(parsed.body, /Step 1/);
});

test('parseSkillDocument supports standard YAML list syntax', () => {
  const parsed = parseSkillDocument(`---
name: demo
description: Demo skill
tags:
  - repo
  - investigation
conflicts_with:
  - quick-fix
metadata:
  short_description: Standard YAML demo
---
Body
`);

  assert.deepEqual(parsed.tags, ['repo', 'investigation']);
  assert.deepEqual(parsed.conflictsWith, ['quick-fix']);
  assert.equal(parsed.shortDescription, 'Standard YAML demo');
});

test('SkillManager falls back to legacy metadata when SKILL.md is not standard frontmatter', () => {
  const userHome = makeTempDir();
  const userRoot = join(userHome, '.cligate', 'skills');
  const legacyDir = join(userRoot, 'pptx');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'SKILL.md'), 'gAAAAABlegacypayload', 'utf8');
  writeFileSync(join(legacyDir, 'editing.md'), '# 编辑演示文稿\n\nLegacy body', 'utf8');
  mkdirSync(join(legacyDir, 'scripts'), { recursive: true });

  const manager = new SkillManager({
    userHome,
    bundledRoot: makeTempDir()
  });
  const discovered = manager.discoverForCwd(makeTempDir(), { forceReload: true });
  const skill = discovered.skills.find((entry) => entry.name === 'pptx');

  assert.ok(skill);
  assert.match(skill.description, /legacy skill package/i);
  assert.equal(skill.shortDescription, '编辑演示文稿');
  assert.deepEqual(skill.tags, ['legacy', 'workflow', 'reference', 'scripts']);
});

test('resolveSkillRoots includes repo, user, and bundled roots by default', () => {
  const cwd = makeTempDir();
  mkdirSync(join(cwd, '.cligate', 'skills'), { recursive: true });
  const userHome = makeTempDir();
  const bundledRoot = join(cwd, 'src', 'bundled-skills');
  mkdirSync(bundledRoot, { recursive: true });

  const roots = resolveSkillRoots({ cwd, userHome, bundledRoot });
  assert.equal(roots.some((entry) => entry.scope === 'repo' && entry.rootDir === join(cwd, '.cligate', 'skills')), true);
  assert.equal(roots.some((entry) => entry.scope === 'user' && entry.rootDir === join(userHome, '.cligate', 'skills')), true);
  assert.equal(roots.some((entry) => entry.scope === 'bundled' && entry.rootDir === bundledRoot), true);
});

test('resolveSkillRoots can include repo roots when explicitly requested', () => {
  const outer = makeTempDir();
  const repoRoot = join(outer, 'repo');
  mkdirSync(join(outer, '.cligate', 'skills'), { recursive: true });
  mkdirSync(join(repoRoot, '.git'), { recursive: true });
  mkdirSync(join(repoRoot, '.cligate', 'skills'), { recursive: true });

  const roots = resolveSkillRoots({
    cwd: repoRoot,
    userHome: makeTempDir(),
    bundledRoot: join(repoRoot, 'src', 'bundled-skills'),
    includeRepoRoots: true
  });

  const repoRoots = roots.filter((entry) => entry.scope === 'repo').map((entry) => entry.rootDir);
  assert.deepEqual(repoRoots, [join(repoRoot, '.cligate', 'skills')]);
});

test('SkillManager discovers skills from roots and dedupes', () => {
  const cwd = makeTempDir();
  const repoRoot = join(cwd, '.cligate', 'skills');
  mkdirSync(repoRoot, { recursive: true });
  writeSkill(repoRoot, 'repo-skill', `---
description: Repo skill
---
Hello
`);
  const userHome = makeTempDir();
  const userRoot = join(userHome, '.cligate', 'skills');
  mkdirSync(userRoot, { recursive: true });
  writeSkill(userRoot, 'user-skill', `---
name: user-skill
description: User skill
---
World
`);

  const manager = new SkillManager({
    userHome,
    bundledRoot: join(cwd, 'src', 'bundled-skills')
  });
  const discovered = manager.discoverForCwd(cwd);
  assert.equal(discovered.skills.some((entry) => entry.name === 'repo-skill'), true);
  assert.equal(discovered.skills.some((entry) => entry.name === 'user-skill'), true);
  assert.equal(discovered.skills.find((entry) => entry.name === 'repo-skill')?.enabled, true);
});

test('SkillManager prefers repo skills over bundled skills when names collide', () => {
  const cwd = makeTempDir();
  const repoRoot = join(cwd, '.cligate', 'skills');
  const bundledRoot = join(cwd, 'src', 'bundled-skills');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(bundledRoot, { recursive: true });
  const repoPath = writeSkill(repoRoot, 'quick-fix', `---
name: quick-fix
description: Repo override
---
Repo body
`);
  writeSkill(bundledRoot, 'quick-fix', `---
name: quick-fix
description: Bundled fallback
---
Bundled body
`);

  const manager = new SkillManager({
    userHome: makeTempDir(),
    bundledRoot
  });
  const discovered = manager.discoverForCwd(cwd, { forceReload: true });
  const quickFix = discovered.skills.find((entry) => entry.name === 'quick-fix');
  assert.ok(quickFix);
  assert.equal(quickFix.pathToSkillMd, repoPath);
  assert.equal(quickFix.description, 'Repo override');
});

test('renderAvailableSkills and renderActiveSkills produce prompt blocks', () => {
  const available = renderAvailableSkills([{
    name: 'demo',
    description: 'Demo skill',
    pathToSkillMd: '/tmp/demo/SKILL.md',
    enabled: true
  }]);
  assert.match(available, /<available_skills>/);
  assert.match(available, /demo: Demo skill/);

  const active = renderActiveSkills([{
    name: 'demo',
    pathToSkillMd: '/tmp/demo/SKILL.md',
    content: 'Do the work'
  }]);
  assert.match(active, /<active_skills>/);
  assert.match(active, /Do the work/);
});

test('collectExplicitSkillMentions and activateSkillsForRun activate selected skills', () => {
  const cwd = makeTempDir();
  const repoRoot = join(cwd, '.cligate', 'skills');
  mkdirSync(repoRoot, { recursive: true });
  const skillPath = writeSkill(repoRoot, 'demo', `---
name: demo
description: Demo skill
---
Follow the steps
`);

  const manager = new SkillManager({
    userHome: makeTempDir(),
    bundledRoot: join(cwd, 'src', 'bundled-skills')
  });
  const discovered = manager.discoverForCwd(cwd);
  const selected = collectExplicitSkillMentions('please use $demo now', discovered.skills);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].pathToSkillMd, skillPath);

  const skillState = activateSkillsForRun({
    run: { metadata: {} },
    availableSkills: discovered.skills,
    selectedSkills: selected,
    loadSkillContent: (skill) => manager.loadSkillContent(skill)
  });
  assert.equal(skillState.active.length, 1);
  assert.match(skillState.active[0].content, /Follow the steps/);
  assert.equal(skillState.history.length, 1);
});

test('collectSuggestedSkills can infer a relevant skill from task text', () => {
  const selected = collectSuggestedSkills('please investigate this repository before editing', [{
    name: 'repo-investigation',
    description: 'Investigate an unfamiliar repository before making changes.',
    whenToUse: 'Use when exploring an unfamiliar repo',
    tags: ['repo', 'investigation'],
    shortDescription: '',
    enabled: true
  }]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].name, 'repo-investigation');
});

test('buildSkillAwareRuntimeInput mounts active skills into delegated runtime input', () => {
  const mounted = buildSkillAwareRuntimeInput('Fix the failing test', [{
    name: 'repo-investigation',
    pathToSkillMd: '/tmp/repo-investigation/SKILL.md',
    content: '1. Inspect the repo\n2. Find the failing test'
  }]);
  assert.match(mounted, /Fix the failing test/);
  assert.match(mounted, /<active_skills>/);
  assert.match(mounted, /Find the failing test/);
});

test('restoreActiveSkillsFromCheckpoint prefers metadata state and falls back to checkpoint', () => {
  const restored = restoreActiveSkillsFromCheckpoint({
    metadata: {
      skills: {
        available: [{ name: 'a' }],
        active: [{ name: 'active-a', content: 'x' }],
        history: [{ name: 'active-a' }]
      },
      checkpoint: {
        skills: {
          active: [{ name: 'checkpoint-a' }],
          history: [{ name: 'checkpoint-a' }]
        }
      }
    }
  });
  assert.equal(restored.active[0].name, 'active-a');
  assert.equal(restored.history[0].name, 'active-a');
});

test('skill manager applies enable/disable settings from persisted config', () => {
  const cwd = makeTempDir();
  const repoRoot = join(cwd, '.cligate', 'skills');
  mkdirSync(repoRoot, { recursive: true });
  const skillPath = writeSkill(repoRoot, 'toggle-me', `---
name: toggle-me
description: Toggle target
---
Body
`);

  setSkillEnabled({ path: skillPath, enabled: false });
  const manager = new SkillManager({
    userHome: makeTempDir(),
    bundledRoot: join(cwd, 'src', 'bundled-skills')
  });
  const discovered = manager.discoverForCwd(cwd, { forceReload: true });
  const toggleSkill = discovered.skills.find((entry) => entry.name === 'toggle-me');
  assert.ok(toggleSkill);
  assert.equal(toggleSkill.enabled, false);
});

test('expireInactiveSkills and replaceActiveSkills update run-scoped active skills', () => {
  const run = {
    metadata: {
      skills: {
        available: [],
        active: [
          { name: 'a', pathToSkillMd: '/a', content: 'A' },
          { name: 'b', pathToSkillMd: '/b', content: 'B' }
        ],
        history: []
      }
    }
  };

  const expired = expireInactiveSkills(run, { keepNames: ['b'] });
  assert.equal(expired.active.length, 1);
  assert.equal(expired.active[0].name, 'b');

  const replaced = replaceActiveSkills(run, [{ name: 'c', pathToSkillMd: '/c', content: 'C' }]);
  assert.equal(replaced.active.length, 1);
  assert.equal(replaced.active[0].name, 'c');
  assert.equal(replaced.history[0].name, 'c');
});

test('shouldReplaceActiveSkills detects when a new skill is a better match than the current active skill', () => {
  const replace = shouldReplaceActiveSkills(
    'please review this pull request before merging',
    [{ name: 'repo-investigation', pathToSkillMd: '/a', content: 'A' }],
    [
      { name: 'repo-investigation', description: 'Investigate an unfamiliar repository before changes.', pathToSkillMd: '/a', enabled: true },
      { name: 'pr-review', description: 'Review a pull request before merging.', pathToSkillMd: '/b', enabled: true }
    ]
  );
  assert.equal(replace, true);
});

test('collectSuggestedSkills skips conflicting skills when selecting multiple suggestions', () => {
  const selected = collectSuggestedSkills('investigate the repo and review the pull request before merging', [
    {
      name: 'repo-investigation',
      description: 'Investigate an unfamiliar repository before making changes.',
      whenToUse: 'Use when exploring an unfamiliar repo',
      conflictsWith: ['quick-fix'],
      enabled: true
    },
    {
      name: 'quick-fix',
      description: 'Apply a fast narrow fix with minimal repo exploration.',
      whenToUse: 'Use for a quick one-file fix',
      conflictsWith: ['repo-investigation'],
      enabled: true
    },
    {
      name: 'pr-review',
      description: 'Review a pull request before merging.',
      whenToUse: 'Use when reviewing a PR before merge',
      enabled: true
    }
  ], { maxCount: 3, minScore: 1 });

  assert.equal(selected.some((entry) => entry.name === 'repo-investigation'), true);
  assert.equal(selected.some((entry) => entry.name === 'pr-review'), true);
  assert.equal(
    selected.some((entry) => entry.name === 'quick-fix') && selected.some((entry) => entry.name === 'repo-investigation'),
    false
  );
});

test('activateSkillsForRun blocks a newly selected skill when the active skill declares a one-way conflict', () => {
  const run = {
    metadata: {
      skills: {
        available: [],
        active: [{
          name: 'repo-investigation',
          pathToSkillMd: '/repo',
          conflictsWith: ['quick-fix'],
          content: 'Investigate first'
        }],
        history: []
      }
    }
  };

  const state = activateSkillsForRun({
    run,
    availableSkills: [],
    selectedSkills: [{
      name: 'quick-fix',
      pathToSkillMd: '/quick-fix',
      scope: 'repo',
      conflictsWith: []
    }],
    loadSkillContent: () => 'Apply a narrow fix'
  });

  assert.equal(state.active.length, 1);
  assert.equal(state.active[0].name, 'repo-investigation');
});
