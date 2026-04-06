export function parseSsePayload(text = '') {
  const events = [];
  let eventName = 'message';
  let dataLines = [];

  const flush = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    events.push({ event: eventName || 'message', data });
    eventName = 'message';
    dataLines = [];
  };

  const normalized = String(text).replace(/\r\n/g, '\n');
  for (const line of normalized.split('\n')) {
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim() || 'message';
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  flush();
  return events;
}

export function summarizeSseText(events = []) {
  const fragments = [];

  for (const entry of events) {
    const raw = entry?.data || '';
    if (!raw || raw === '[DONE]') continue;

    try {
      const parsed = JSON.parse(raw);
      const deltaText = parsed?.delta?.text || parsed?.delta?.text_delta?.text;
      if (typeof deltaText === 'string' && deltaText) {
        fragments.push(deltaText);
        continue;
      }

      const contentDeltaText = parsed?.delta?.type === 'text_delta' ? parsed?.delta?.text : null;
      if (typeof contentDeltaText === 'string' && contentDeltaText) {
        fragments.push(contentDeltaText);
        continue;
      }

      const blockText = parsed?.content_block?.text;
      if (typeof blockText === 'string' && blockText) {
        fragments.push(blockText);
        continue;
      }

      const messageText = Array.isArray(parsed?.message?.content)
        ? parsed.message.content
          .map((item) => (typeof item?.text === 'string' ? item.text : ''))
          .join('')
        : '';
      if (messageText) {
        fragments.push(messageText);
      }
    } catch {
      fragments.push(raw);
    }
  }

  return fragments.join('');
}
