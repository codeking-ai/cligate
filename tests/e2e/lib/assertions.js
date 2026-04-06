import { summarizeSseText } from './sse-parser.js';

function readPath(source, path) {
  if (!path) return source;
  const tokens = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current = source;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    current = current[token];
  }
  return current;
}

function result(type, passed, message, extra = {}) {
  return { type, passed, message, ...extra };
}

function assertStatus(assertion, context) {
  const actual = context.response.status;
  const expected = assertion.expected;
  return result(
    assertion.type,
    actual === expected,
    actual === expected ? `status=${actual}` : `expected status ${expected}, got ${actual}`,
    { expected, actual }
  );
}

function assertContentType(assertion, context) {
  const actual = String(context.response.headers['content-type'] || '');
  const expected = assertion.contains;
  return result(
    assertion.type,
    actual.includes(expected),
    actual.includes(expected) ? `content-type contains ${expected}` : `expected content-type containing ${expected}, got ${actual}`,
    { expected, actual }
  );
}

function assertBodyJsonExists(assertion, context) {
  const actual = readPath(context.response.json, assertion.path);
  return result(
    assertion.type,
    actual !== undefined && actual !== null,
    actual !== undefined && actual !== null ? `${assertion.path} exists` : `${assertion.path} is missing`,
    { path: assertion.path, actual }
  );
}

function assertBodyJsonType(assertion, context) {
  const actual = readPath(context.response.json, assertion.path);
  const actualType = Array.isArray(actual) ? 'array' : typeof actual;
  return result(
    assertion.type,
    actualType === assertion.expected,
    actualType === assertion.expected ? `${assertion.path} type=${actualType}` : `expected ${assertion.path} type ${assertion.expected}, got ${actualType}`,
    { path: assertion.path, expected: assertion.expected, actual: actualType }
  );
}

function assertBodyTextContains(assertion, context) {
  const haystack = context.response.json
    ? JSON.stringify(context.response.json)
    : ((context.response.events?.length ? summarizeSseText(context.response.events) : '') + '\n' + (context.response.rawText || ''));
  const expected = assertion.contains;
  return result(
    assertion.type,
    haystack.includes(expected),
    haystack.includes(expected) ? `body contains ${expected}` : `expected body to contain ${expected}`,
    { expected }
  );
}

function assertSseEventSequence(assertion, context) {
  const actualEvents = (context.response.events || []).map((event) => event.event);
  const expected = assertion.contains || [];
  let cursor = 0;
  for (const eventName of actualEvents) {
    if (eventName === expected[cursor]) cursor += 1;
    if (cursor >= expected.length) break;
  }
  const passed = cursor >= expected.length;
  return result(
    assertion.type,
    passed,
    passed ? `sse event sequence matched` : `expected SSE events in order: ${expected.join(', ')}`,
    { expected, actual: actualEvents }
  );
}

function assertDurationMax(assertion, context) {
  const actual = context.response.durationMs;
  const expected = assertion.maxMs;
  return result(
    assertion.type,
    actual <= expected,
    actual <= expected ? `duration ${actual}ms <= ${expected}ms` : `expected duration <= ${expected}ms, got ${actual}ms`,
    { expected, actual }
  );
}

function assertRequestLog(assertion, context) {
  const expected = assertion.expected || {};
  const entry = context.evidence.requestLogs.find((item) => {
    return Object.entries(expected).every(([key, value]) => item?.[key] === value);
  });
  return result(
    assertion.type,
    Boolean(entry),
    entry ? `matched request log ${entry.id}` : `no matching request log found`,
    { expected, actual: entry || null }
  );
}

function assertRoutingDecision(assertion, context) {
  const expected = assertion.expected || {};
  const entry = context.evidence.routingDecisions.find((item) => {
    return Object.entries(expected).every(([key, value]) => item?.[key] === value);
  });
  return result(
    assertion.type,
    Boolean(entry),
    entry ? `matched routing decision at ${entry.at}` : `no matching routing decision found`,
    { expected, actual: entry || null }
  );
}

const HANDLERS = {
  status: assertStatus,
  'content-type': assertContentType,
  'body-json-exists': assertBodyJsonExists,
  'body-json-type': assertBodyJsonType,
  'body-text-contains': assertBodyTextContains,
  'sse-event-sequence': assertSseEventSequence,
  'duration-max': assertDurationMax,
  'request-log': assertRequestLog,
  'routing-decision': assertRoutingDecision
};

export function evaluateAssertions(assertions = [], context) {
  return assertions.map((assertion) => {
    const handler = HANDLERS[assertion.type];
    if (!handler) {
      return result(assertion.type, false, `unsupported assertion type: ${assertion.type}`);
    }
    return handler(assertion, context);
  });
}

export function summarizeResponseForReport(response) {
  return {
    status: response.status,
    durationMs: response.durationMs,
    contentType: response.headers?.['content-type'] || '',
    bodyPreview: response.rawText ? response.rawText.slice(0, 800) : '',
    ssePreview: response.events ? summarizeSseText(response.events).slice(0, 800) : ''
  };
}
