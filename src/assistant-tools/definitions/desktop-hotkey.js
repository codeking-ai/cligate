export function createDesktopHotkeyToolDefinition({ handlers }) {
  return {
    name: 'desktop_hotkey',
    description: 'Send a key combination to the focused window (no control selector needed). Critical for app-level shortcuts that do not require finding a specific control — Ctrl+L (focus address bar in any browser), Ctrl+T (new tab), Ctrl+W (close tab), Alt+F4 (close window), Alt+Tab (switch window), Ctrl+C / Ctrl+V (copy/paste). Pass keys as an array of names in pressed order, e.g. ["ctrl","l"] or ["ctrl","shift","t"]. Use desktop_focus_window first to make sure the right app receives the combo.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered key names to press together, e.g. ["ctrl","l"]. Released in reverse order. Supports ctrl, shift, alt, win plus the same single keys as desktop_press_key.'
        }
      },
      required: ['keys']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: true,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.desktopHotkey
  };
}

export default createDesktopHotkeyToolDefinition;
