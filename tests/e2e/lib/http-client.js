import { parseSsePayload } from './sse-parser.js';

function buildUrl(baseUrl, path) {
  return new URL(path, baseUrl).toString();
}

export async function sendJsonRequest(baseUrl, request) {
  const startedAt = Date.now();
  const headers = { ...(request.headers || {}) };
  const init = {
    method: request.method || 'POST',
    headers
  };

  if (request.body !== undefined) {
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
    init.body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
  }

  const response = await fetch(buildUrl(baseUrl, request.path), init);
  const rawText = await response.text();
  const durationMs = Date.now() - startedAt;
  let json = null;
  try {
    json = rawText ? JSON.parse(rawText) : null;
  } catch {
    json = null;
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    rawText,
    json,
    durationMs
  };
}

export async function sendSseRequest(baseUrl, request) {
  const startedAt = Date.now();
  const headers = { ...(request.headers || {}) };
  const init = {
    method: request.method || 'POST',
    headers
  };

  if (request.body !== undefined) {
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
    init.body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
  }

  const response = await fetch(buildUrl(baseUrl, request.path), init);
  const rawText = await response.text();
  const durationMs = Date.now() - startedAt;
  const events = parseSsePayload(rawText);

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    rawText,
    events,
    durationMs
  };
}
