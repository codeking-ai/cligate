import yaml from 'js-yaml';

function normalizeSingleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.map(normalizeSingleLine).filter(Boolean)
    : [];
}

export function extractSkillFrontmatter(source = '') {
  const text = String(source || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error('SKILL.md must begin with YAML frontmatter');
  }
  return {
    frontmatter: match[1],
    body: match[2] || ''
  };
}

export function parseSkillDocument(source = '', { fallbackName = '' } = {}) {
  const { frontmatter, body } = extractSkillFrontmatter(source);
  const parsed = yaml.load(frontmatter) || {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('skill frontmatter must be a YAML object');
  }
  const metadata = parsed.metadata && typeof parsed.metadata === 'object'
    ? parsed.metadata
    : {};

  const name = normalizeSingleLine(parsed.name || fallbackName);
  const description = normalizeSingleLine(parsed.description || '');
  const shortDescription = normalizeSingleLine(metadata.short_description || metadata.shortDescription || '');
  const whenToUse = normalizeSingleLine(parsed.when_to_use || parsed.whenToUse || '');
  const tags = normalizeStringList(parsed.tags);
  const conflictsWith = normalizeStringList(parsed.conflicts_with || parsed.conflictsWith);

  if (!name) {
    throw new Error('skill name is required');
  }
  if (!description) {
    throw new Error('skill description is required');
  }

  return {
    name,
    description,
    shortDescription,
    whenToUse,
    tags,
    conflictsWith,
    body: String(body || '')
  };
}
