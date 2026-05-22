function truncate(value, limit = 240) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

export function renderAvailableSkills(skills = []) {
  const enabledSkills = Array.isArray(skills)
    ? skills.filter((entry) => entry?.enabled !== false)
    : [];
  if (enabledSkills.length === 0) {
    return '';
  }
  return [
    '<available_skills>',
    'The following skills are available. Use them only when relevant. Load full skill instructions only for explicitly activated skills.',
    ...enabledSkills.map((skill) => (
      `- ${skill.name}: ${truncate(skill.description)}${skill.whenToUse ? ` | when: ${truncate(skill.whenToUse, 120)}` : ''} (file: ${skill.pathToSkillMd})`
    )),
    '</available_skills>'
  ].join('\n');
}

export function renderActiveSkills(skills = []) {
  const activeSkills = Array.isArray(skills) ? skills.filter(Boolean) : [];
  if (activeSkills.length === 0) {
    return '';
  }
  return [
    '<active_skills>',
    'These skills are currently active for this run. Continue following them in later steps of the same run.',
    ...activeSkills.flatMap((skill) => ([
      '<skill>',
      `<name>${skill.name}</name>`,
      `<path>${skill.pathToSkillMd}</path>`,
      skill.content || '',
      '</skill>'
    ])),
    '</active_skills>'
  ].join('\n');
}
