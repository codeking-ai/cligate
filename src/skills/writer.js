import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';

import { parseSkillDocument } from './parser.js';
import { redactSecrets } from '../utils/redact-secrets.js';

// The single low-level "materialize a skill to disk" primitive. Both Phase C
// entry points funnel through here:
//   - promote_memory_to_skill (deterministic, from a stored memory)
//   - the conversational authoring flow (agent-drafted, from dialogue)
// so the format/validation/registration rules live in exactly one place.

function normalizeText(value) {
  return String(value || '').trim();
}

// A filesystem-safe directory stem for the skill. Keeps unicode letters (incl.
// Chinese) and ascii alnum/dash; strips characters illegal in path segments.
export function skillDirName(name) {
  const cleaned = normalizeText(name)
    .toLowerCase()
    .replace(/[<>:"/\\|?*]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9一-鿿-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || `skill-${randomUUID().slice(0, 8)}`;
}

function composeSkillDocument({ name, description, whenToUse, tags }) {
  const frontmatter = { name, description };
  if (normalizeText(whenToUse)) frontmatter.when_to_use = normalizeText(whenToUse);
  const cleanTags = Array.isArray(tags) ? tags.map(normalizeText).filter(Boolean) : [];
  if (cleanTags.length > 0) frontmatter.tags = cleanTags;
  const yamlStr = yaml.dump(frontmatter, { lineWidth: 1000, noRefs: true });
  return { frontmatter, yamlStr };
}

// Write (or overwrite) a SKILL.md under the USER skills root. Validates the
// composed document with the real parser before touching disk, and refuses to
// clobber an existing skill unless overwrite is explicitly requested.
export function saveSkill({
  name,
  description,
  whenToUse = '',
  tags = [],
  body = '',
  overwrite = false,
  userHome = homedir()
} = {}) {
  const skillName = normalizeText(name);
  const desc = normalizeText(description);
  // Defense-in-depth: scrub credentials from the persisted skill (G7).
  const skillBody = redactSecrets(String(body || '').trim());
  whenToUse = redactSecrets(whenToUse);

  if (!skillName) return { ok: false, code: 'INVALID_INPUT', error: 'skill name is required' };
  if (!desc) return { ok: false, code: 'INVALID_INPUT', error: 'skill description is required' };
  if (!skillBody) return { ok: false, code: 'INVALID_INPUT', error: 'skill body is required' };

  const dir = normalizeText(skillDirName(skillName));
  const { yamlStr } = composeSkillDocument({ name: skillName, description: desc, whenToUse, tags });
  const document = `---\n${yamlStr}---\n\n${skillBody}\n`;

  // Validate against the SAME parser the loader uses — guarantees the skill we
  // write is one the runtime can actually read back.
  try {
    parseSkillDocument(document, { fallbackName: dir });
  } catch (err) {
    return { ok: false, code: 'INVALID_SKILL', error: `composed SKILL.md failed validation: ${err?.message || err}` };
  }

  const skillsRoot = join(normalizeText(userHome) || homedir(), '.cligate', 'skills');
  const skillDir = join(skillsRoot, dir);
  const skillPath = join(skillDir, 'SKILL.md');

  if (existsSync(skillPath) && !overwrite) {
    return {
      ok: false,
      code: 'SKILL_EXISTS',
      name: skillName,
      path: skillPath,
      error: `a skill already exists at ${skillPath}; pass overwrite:true to replace it`
    };
  }

  try {
    mkdirSync(skillDir, { recursive: true, mode: 0o700 });
    writeFileSync(skillPath, document, { mode: 0o600 });
  } catch (err) {
    return { ok: false, code: 'WRITE_FAILED', error: String(err?.message || err) };
  }

  return { ok: true, name: skillName, dir, path: skillPath, overwritten: existsSync(skillPath) && overwrite };
}

export default saveSkill;
