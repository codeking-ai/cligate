import { getServerSettings, setServerSettings } from '../server-settings.js';

function toText(value) {
  return String(value || '').trim();
}

export function getSkillSettings() {
  return getServerSettings().skills || { enabled: true, config: [] };
}

export function setSkillSettings(skills = {}) {
  const settings = setServerSettings({ skills });
  return settings.skills || { enabled: true, config: [] };
}

export function setSkillEnabled({ path = '', name = '', enabled = true } = {}) {
  const normalizedPath = toText(path);
  const normalizedName = toText(name);
  if (!normalizedPath && !normalizedName) {
    throw new Error('path or name is required');
  }
  const current = getSkillSettings();
  const entries = Array.isArray(current.config) ? current.config : [];
  const filtered = entries.filter((entry) => {
    if (normalizedPath && toText(entry?.path) === normalizedPath) return false;
    if (normalizedName && toText(entry?.name) === normalizedName) return false;
    return true;
  });
  return setSkillSettings({
    ...current,
    config: [
      ...filtered,
      {
        ...(normalizedPath ? { path: normalizedPath } : {}),
        ...(normalizedName ? { name: normalizedName } : {}),
        enabled: enabled !== false
      }
    ]
  });
}

export function resolveSkillEnabled(skill = null, settings = null) {
  const current = settings || getSkillSettings();
  if (current?.enabled === false) {
    return false;
  }
  const entries = Array.isArray(current?.config) ? current.config : [];
  const path = toText(skill?.pathToSkillMd);
  const name = toText(skill?.name);
  let enabled = true;
  for (const entry of entries) {
    if (entry?.path && toText(entry.path) === path) {
      enabled = entry.enabled !== false;
    }
    if (entry?.name && toText(entry.name) === name) {
      enabled = entry.enabled !== false;
    }
  }
  return enabled;
}
