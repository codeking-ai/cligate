export function createDesktopInspectWindowToolDefinition({ handlers }) {
  return {
    name: 'desktop_inspect_window',
    description: [
      'Inspect a desktop window using Set-of-Marks (SOM): returns an annotated screenshot with every interactive control (Edit, Button, Hyperlink, ContentEditable, etc.) overlaid with a numbered red/blue/green/orange box, PLUS a `marks` table giving each mark a complete UIA selector.',
      '',
      'This is the PREFERRED tool for ANY task that needs to interact with multiple fields in a complex editor (WeChat MP article editor, web forms, Word, Notion-like apps). Workflow:',
      '  1. desktop_focus_window(hwnd)',
      '  2. desktop_inspect_window(hwnd) — you SEE the boxed image AND read the marks JSON',
      '  3. Pick the right mark visually (e.g. "mark 3 is the title field")',
      '  4. Call desktop_set_control_value with the mark\'s controlType + automationId + name — UIA invoke is pixel-perfect, no coordinate guessing',
      '  5. desktop_inspect_window again to verify the value landed in the right field',
      '',
      'Why use this instead of desktop_capture_window + desktop_click_at: coordinate clicks from screenshot preview have ±20px error; when input fields are narrow (title bars in editors are often 30-40px tall) this routinely misses and the next type_text goes to the wrong field — typical symptom: "I clicked the title field but the body text was written to the body editor instead". Marks are anchored to actual UIA controls so this misalignment is impossible.',
      '',
      'For windows with very deep trees (Chrome / Electron apps) pass max_marks=50 and max_depth=24 (defaults are already these). Each mark color: red=text-entry, blue=button, green=link, orange=other.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        windowHwnd: { type: 'integer', description: 'Preferred: pass the hwnd returned by desktop_list_windows.' },
        windowTitle: { type: 'string' },
        windowClass: { type: 'string' },
        windowMatch: { type: 'string', enum: ['contains', 'exact', 'regex'] },
        maxMarks: { type: 'integer', minimum: 1, maximum: 200, description: 'Cap on annotated controls (default 50). Raise if the editor has many fields.' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 64, description: 'UIA tree depth to walk (default 24). Raise for very deep Chrome/Electron trees.' },
        previewWidth: { type: 'integer', minimum: 64, maximum: 4096, description: 'Pixel width of the preview image returned to the LLM (default 1280). Smaller → less context tokens; larger → easier to read mark numbers.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 }
      }
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'hosted',
    execute: handlers.desktopInspectWindow
  };
}

export default createDesktopInspectWindowToolDefinition;
