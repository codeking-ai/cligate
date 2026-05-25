export function classifyDesktopToolRisk(toolName = '') {
  switch (String(toolName || '').trim()) {
    case 'desktop_health':
    case 'desktop_list_windows':
      return 'read-only';
    default:
      return 'semantic';
  }
}

export default {
  classifyDesktopToolRisk
};
