import { getServerSettings, setServerSettings } from '../server-settings.js';

export function getDesktopAgentSettings() {
  return getServerSettings().desktopAgent || {};
}

export function setDesktopAgentSettings(patch = {}) {
  const current = getDesktopAgentSettings();
  const desktopAgent = {
    ...current,
    ...(patch && typeof patch === 'object' ? patch : {})
  };
  const next = setServerSettings({ desktopAgent });
  return next.desktopAgent || {};
}

export default {
  getDesktopAgentSettings,
  setDesktopAgentSettings
};
