export function createDesktopScrollToolDefinition({ handlers }) {
  return {
    name: 'desktop_scroll',
    description: 'Scroll the mouse wheel at the cursor\'s CURRENT position. Critical for reaching content below/above the fold — WeChat MP article editor, long forms, etc. Positive `amount` scrolls UP, negative scrolls DOWN. Each unit ≈ 120 (one wheel notch). Typical step: ±3 to ±5 for one viewport. IMPORTANT: the scroll lands at the cursor location, so for scrolling a specific pane/window you usually want desktop_move_mouse first to move the cursor into that pane, then desktop_scroll. After scrolling, follow with desktop_capture_window to verify what is now visible. To go to the very top/bottom, prefer desktop_press_key("home") / desktop_press_key("end") with a focused field, or desktop_hotkey(["ctrl","home"]) / desktop_hotkey(["ctrl","end"]).',
    inputSchema: {
      type: 'object',
      properties: {
        amount: {
          type: 'integer',
          description: 'Wheel notches. Positive = scroll up (away from user). Negative = scroll down. Typical range ±1 to ±10.'
        }
      },
      required: ['amount']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: true,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.desktopScroll
  };
}

export default createDesktopScrollToolDefinition;
