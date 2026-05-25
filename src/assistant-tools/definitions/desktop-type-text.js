export function createDesktopTypeTextToolDefinition({ handlers }) {
  return {
    name: 'desktop_type_text',
    description: 'Type free-form text into whatever currently has focus (no control selector needed). Uses clipboard paste internally for reliable Unicode/CJK input, restoring the previous clipboard contents afterwards. Typical flow for any browser: desktop_focus_window → desktop_hotkey(["ctrl","l"]) → desktop_type_text("www.qq.com") → desktop_press_key("enter"). For text destined for a SPECIFIC named input control prefer desktop_set_control_value, which is focus-independent.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to type into the focused field. Supports any Unicode characters including Chinese.'
        },
        preserveClipboard: {
          type: 'boolean',
          description: 'When true (default) restore the user\'s previous clipboard after typing. Set to false only if you specifically do not want to restore it.'
        }
      },
      required: ['text']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: true,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.desktopTypeText
  };
}

export default createDesktopTypeTextToolDefinition;
