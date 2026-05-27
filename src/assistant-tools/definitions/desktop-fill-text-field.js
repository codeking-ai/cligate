export function createDesktopFillTextFieldToolDefinition({ handlers }) {
  return {
    name: 'desktop_fill_text_field',
    description: 'Find a specific text-entry control, set its value through UIA, optionally submit it, and verify the final value. Use this as the preferred high-level tool for filling named inputs in desktop apps, browser windows with accessible controls, and complex editors that still expose UIA. This wraps the stable workflow: locate control -> set value -> read back -> optional submit key.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        windowHwnd: { type: 'integer' },
        windowTitle: { type: 'string' },
        windowClass: { type: 'string' },
        windowMatch: { type: 'string', enum: ['contains', 'exact', 'regex'] },
        controlType: {
          type: 'string',
          default: 'Edit',
          description: 'Defaults to Edit because this tool is specifically for text-entry fields.'
        },
        name: { type: 'string' },
        nameMatch: { type: 'string', enum: ['contains', 'exact', 'regex'] },
        automationId: { type: 'string' },
        className: { type: 'string' },
        searchDepth: { type: 'integer', minimum: 1, maximum: 64, default: 32 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120000, default: 4000 },
        text: { type: 'string', description: 'The final field value to write.' },
        submitKeys: {
          type: 'string',
          description: 'Optional follow-up UIA SendKeys sequence, e.g. `{Enter}`.'
        },
        requireExactReadback: {
          type: 'boolean',
          default: true,
          description: 'When true, fail unless the read-back text exactly equals `text`.'
        },
        leaseId: { type: 'string' },
        sessionId: { type: 'string' }
      }
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: true,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.desktopFillTextField
  };
}

export default createDesktopFillTextFieldToolDefinition;
