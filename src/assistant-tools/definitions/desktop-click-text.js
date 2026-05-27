export function createDesktopClickTextToolDefinition({ handlers }) {
  return {
    name: 'desktop_click_text',
    description: 'Find visible text inside a target window or region, click the best OCR match, and verify that the UI responded. Use this for self-drawn or DirectUI windows where desktop_find_control cannot expose a semantic selector but the target is still identified by text such as "Next", "Publish", "OK", or "Custom Install". The tool performs the full server-side flow: OCR match selection -> click center -> optional wait_change verification. Prefer this over manually chaining desktop_find_text + desktop_click_at + desktop_wait_change when the target is identified primarily by text.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Visible text to click.' },
        match: { type: 'string', enum: ['contains', 'exact', 'regex'], default: 'contains' },
        windowHwnd: { type: 'integer' },
        windowTitle: { type: 'string' },
        windowClass: { type: 'string' },
        windowMatch: { type: 'string', enum: ['contains', 'exact', 'regex'] },
        region: {
          type: 'object',
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            w: { type: 'integer' },
            h: { type: 'integer' }
          }
        },
        minConfidence: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        maxResults: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        occurrence: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          default: 1,
          description: 'Which ranked OCR match to click after sorting by confidence and geometry. 1 = best match.'
        },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        clicks: { type: 'integer', minimum: 1, maximum: 5, default: 1 },
        verifyHover: { type: 'boolean', default: false },
        waitForChange: {
          type: 'boolean',
          default: true,
          description: 'When true, run desktop_wait_change after the click.'
        },
        timeoutMs: {
          type: 'integer',
          minimum: 50,
          maximum: 15000,
          default: 1500,
          description: 'Used for the post-click wait_change verification.'
        },
        pollMs: { type: 'integer', minimum: 50, maximum: 2000, default: 200 },
        threshold: { type: 'number', minimum: 0, maximum: 255, default: 2.0 },
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
    execute: handlers.desktopClickText
  };
}

export default createDesktopClickTextToolDefinition;
