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
    'EXECUTION DISCIPLINE: when a skill is active you are the one running it. Execute every step yourself using your local tools — read_file / write_file / replace_in_file / run_shell_command / view_image / list_directory / MCP tools — exactly as the SKILL.md describes. The SKILL.md was written for the agent that hosts the skill (that is you), so its `python -m ...`, `npm ...`, `pdftoppm`, `soffice`, file-edit, and Read/Write style commands are instructions to YOU. They are NOT prompts for a downstream runtime.',
    'DO NOT delegate the skill to codex / claude-code (delegate_to_codex / delegate_to_claude_code / delegate_to_runtime / start_runtime_task / continue_task / send_runtime_input). Codex and Claude Code do NOT load this SKILL.md or the linked helper files like editing.md or pptxgenjs.md — they only see whatever text you paste into the task prompt, which is strictly inferior to running the skill yourself. Only delegate when the user explicitly says so (e.g. "用 codex 跑"), or the skill itself requires a capability you provably lack on the current host AND you have already attempted the local execution and seen a concrete environment failure (record that failure in your reply).',
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
