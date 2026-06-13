export function createWebFetchToolDefinition({ handlers }) {
  return {
    name: 'web_fetch',
    description: [
      'Fetch a public http(s) URL and return its readable text (HTML is converted to compact text with [link](url) markdown; titles and headings preserved).',
      'Use after web_search to read the most relevant results, or when the user gives you a URL directly.',
      'Content longer than maxChars is truncated with an explicit flag — refetch with a higher maxChars or a more specific page if you need more.',
      'Private/intranet hosts (localhost, 10.x, 192.168.x, *.local, …) are blocked by design. Responses are cached ~15 minutes.',
      'When you quote or rely on fetched content in your reply, cite the URL.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
        maxChars: { type: 'integer', minimum: 1000, maximum: 50000, description: 'Max characters of extracted text to return (default 20000).' }
      },
      required: ['url']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'hosted',
    execute: handlers.webFetch
  };
}

export default createWebFetchToolDefinition;
