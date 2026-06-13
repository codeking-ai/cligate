export function createWebSearchToolDefinition({ handlers }) {
  return {
    name: 'web_search',
    description: [
      'Search the web (free, keyless engines: DuckDuckGo/Bing, optional SearXNG) and get back result blocks of {title, url, snippet}.',
      'USE WHEN: the question involves time-sensitive information (news, releases, version numbers, prices, weather, sports, exchange rates), facts you are unsure about or that may have changed after your training data, or the user explicitly asks to search the web.',
      'DO NOT use for things you reliably know (basic concepts, language syntax, stable APIs).',
      'Snippets are NOT enough to answer from — follow up with web_fetch on the 1-3 most relevant urls to read the actual page, then answer and ALWAYS cite the source URLs as markdown links.',
      'Include the current year in the query when searching for "latest/recent" topics.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query. Be specific; include the current year for recency-sensitive topics.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max results to return (default 8).' },
        engine: {
          type: 'string',
          enum: ['duckduckgo', 'bing', 'searxng'],
          description: 'Optional: force a specific engine. Omit to use the default fallback chain.'
        }
      },
      required: ['query']
    },
    outputSchema: { type: 'object' },
    visibility: 'direct',
    mutating: false,
    requiresApproval: false,
    parallelSafe: true,
    source: 'hosted',
    execute: handlers.webSearch
  };
}

export default createWebSearchToolDefinition;
