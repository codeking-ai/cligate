export function createDesktopFindTextToolDefinition({ handlers }) {
  return {
    name: 'desktop_find_text',
    description: 'OCR the desktop / a window / a region and return the bounding boxes of text that matches `query`. Use this as the UIA-free path for self-drawn / DirectUI windows (Dingtalk installer, parts of WeChat / QQ, some game launchers) where desktop_find_control returns ControlNotFound. If your goal is to CLICK the matched text, prefer desktop_click_text so the server performs OCR match selection, clicking, and post-click verification for you. Scope with `windowHwnd` so OCR only runs on the target window — full-screen OCR is slower and surfaces unrelated browser / dashboard text as false positives. Pass match="contains" (default), "exact", or "regex". Each match returns `{text, confidence, bbox:[x,y,w,h], center:[x,y]}` in SCREEN coordinates. Requires rapidocr-onnxruntime installed on the desktop-agent Python; the first call downloads ~30 MB of ONNX models and may take 5-10 seconds.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Text to search for. Case-insensitive when match="contains".' },
        match: { type: 'string', enum: ['contains', 'exact', 'regex'], default: 'contains' },
        windowHwnd: { type: 'integer' },
        windowTitle: { type: 'string' },
        windowClass: { type: 'string' },
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
        leaseId: { type: 'string' },
        sessionId: { type: 'string' }
      }
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: false,
    source: 'hosted',
    execute: handlers.desktopFindText
  };
}

export default createDesktopFindTextToolDefinition;
