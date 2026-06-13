export function createReadDocumentToolDefinition({ handlers }) {
  return {
    name: 'read_document',
    description: [
      'Extract readable text from a rich or binary document: PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), as well as plain text/markdown/csv/json and HTML.',
      'Use this for user-attached files and any non-code document — use read_file instead for source code and small UTF-8 text files.',
      'Returns extracted text plus totalChars; long documents are truncated with an explicit flag — call again with a higher offset to page through the rest.',
      'Spreadsheets come back as tab-separated rows; slides/sheets are split with "## Slide N" / "## Sheet N" headers.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the document (absolute, or relative to the workspace cwd). Uploaded attachments live under ~/.cligate/uploads.' },
        maxChars: { type: 'integer', minimum: 1000, maximum: 200000, description: 'Max characters of extracted text to return (default 20000).' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset to start from when paging a long document (default 0).' }
      },
      required: ['path']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'hosted',
    execute: handlers.readDocument
  };
}

export default createReadDocumentToolDefinition;
