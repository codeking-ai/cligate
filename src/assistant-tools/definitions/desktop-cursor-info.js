export function createDesktopCursorInfoToolDefinition({ handlers }) {
  return {
    name: 'desktop_cursor_info',
    description: 'Return the current cursor SHAPE and position. Windows changes the cursor based on the window underneath: arrow over background, hand over hyperlinks / web-style buttons, ibeam over text input, wait when the app is busy. Use this RIGHT AFTER desktop_move_mouse to verify the cursor actually landed on an interactive element BEFORE issuing desktop_click_at — especially on ATL / DirectUI installers (Dingtalk, WeChat, QQ) and other self-drawn UIs where desktop_find_control returns ControlNotFound. Returns {x, y, shape, is_clickable_hint}. shape is one of: arrow, hand, ibeam, wait, cross, size_*, no, appstarting, help, custom, none. is_clickable_hint=true when shape is hand/ibeam/help — the classic "this element is interactive" signals. NOTE: native Win32 push buttons may keep the cursor as arrow yet still be clickable, so a "false" hint does not strictly mean unclickable; but a "true" hint is strong positive evidence. Also: this reading is NOT blocked by UIPI, so it works even against elevated installers — pair it with desktop_health.elevated to disambiguate "wrong position" from "input being dropped due to elevation gap".',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'hosted',
    execute: handlers.desktopCursorInfo
  };
}

export default createDesktopCursorInfoToolDefinition;
