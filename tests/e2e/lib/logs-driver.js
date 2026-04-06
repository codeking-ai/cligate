import { sendJsonRequest } from './http-client.js';

function isAtOrAfter(isoValue, startedAtIso) {
  if (!isoValue || !startedAtIso) return false;
  return isoValue >= startedAtIso;
}

export async function getRecentRequestLogs(baseUrl, { limit = 20 } = {}) {
  const response = await sendJsonRequest(baseUrl, {
    method: 'GET',
    path: `/api/request-logs?limit=${encodeURIComponent(limit)}`
  });
  if (response.status >= 400 || !response.json) {
    return [];
  }
  return response.json.entries || [];
}

export async function getRecentRoutingDecisions(baseUrl, { limit = 20 } = {}) {
  const response = await sendJsonRequest(baseUrl, {
    method: 'GET',
    path: `/api/runtime/routing-decisions?limit=${encodeURIComponent(limit)}`
  });
  if (response.status >= 400 || !response.json) {
    return [];
  }
  return response.json.decisions || [];
}

export async function collectEvidence(baseUrl, startedAtIso) {
  const [requestLogs, routingDecisions] = await Promise.all([
    getRecentRequestLogs(baseUrl),
    getRecentRoutingDecisions(baseUrl)
  ]);

  return {
    requestLogs: requestLogs.filter((entry) => isAtOrAfter(entry.timestamp, startedAtIso)),
    routingDecisions: routingDecisions.filter((entry) => isAtOrAfter(entry.at, startedAtIso))
  };
}
