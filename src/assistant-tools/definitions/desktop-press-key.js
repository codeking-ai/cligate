export function createDesktopPressKeyToolDefinition({ handlers }) {
  return {
    name: 'desktop_press_key',
    description: 'Press a single key on the focused window (no control selector needed). Use this when you only need a keystroke and not a control match — e.g. `enter` after typing a URL, `escape` to dismiss a dialog, `f5` to reload, `tab` to move focus. For key combos like Ctrl+L use desktop_hotkey instead. For free-form text use desktop_type_text.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Key name (case-insensitive). Accepts: enter, escape, tab, space, backspace, delete, home, end, left, right, up, down, ctrl, shift, alt, win, a-z, 0-9, f1-f24.'
        }
      },
      required: ['key']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: true,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.desktopPressKey
  };
}

export default createDesktopPressKeyToolDefinition;
