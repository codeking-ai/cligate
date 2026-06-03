import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveSkill, skillDirName } from '../../src/skills/writer.js';
import { discoverSkillsUnderRoot } from '../../src/skills/loader.js';
import { SKILL_SCOPE } from '../../src/skills/models.js';

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'cligate-skillhome-'));
}

test('saveSkill writes a SKILL.md that the loader can discover and parse', () => {
  const home = tempHome();
  const res = saveSkill({
    name: 'wechat-publish',
    description: 'Publish an article on the WeChat platform. Use when the user wants to 发文/推送.',
    whenToUse: '发文 推送',
    tags: ['memory-derived', 'procedure'],
    body: '# WeChat publish\n1. open browser\n2. login\n## gotchas\n- editor is an iframe',
    userHome: home
  });
  assert.equal(res.ok, true);
  assert.ok(res.path.includes('wechat-publish'));

  const root = { scope: SKILL_SCOPE.USER, rootDir: join(home, '.cligate', 'skills') };
  const skills = discoverSkillsUnderRoot(root);
  const found = skills.find((s) => s.name === 'wechat-publish');
  assert.ok(found, 'the written skill must be discoverable by the loader');
  assert.ok(found.description.includes('WeChat'));
  assert.equal(found.whenToUse, '发文 推送');
});

test('saveSkill rejects missing required fields', () => {
  const home = tempHome();
  assert.equal(saveSkill({ name: '', description: 'd', body: 'b', userHome: home }).code, 'INVALID_INPUT');
  assert.equal(saveSkill({ name: 'n', description: '', body: 'b', userHome: home }).code, 'INVALID_INPUT');
  assert.equal(saveSkill({ name: 'n', description: 'd', body: '', userHome: home }).code, 'INVALID_INPUT');
});

test('saveSkill refuses to overwrite an existing skill unless overwrite:true', () => {
  const home = tempHome();
  assert.equal(saveSkill({ name: 'dup', description: 'd1', body: 'b1', userHome: home }).ok, true);
  const blocked = saveSkill({ name: 'dup', description: 'd2', body: 'b2', userHome: home });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'SKILL_EXISTS');
  assert.equal(saveSkill({ name: 'dup', description: 'd3', body: 'b3', userHome: home, overwrite: true }).ok, true);
});

test('skillDirName yields a filesystem-safe stem (and a fallback for empty)', () => {
  assert.equal(skillDirName('WeChat Publish!'), 'wechat-publish');
  assert.ok(skillDirName('   ').startsWith('skill-'));
});
