import { sendJsonRequest } from './http-client.js';

const SNAPSHOTS = [
  {
    key: 'accountStrategy',
    getPath: '/settings/account-strategy',
    postPath: '/settings/account-strategy',
    pick: (body) => ({ accountStrategy: body.accountStrategy })
  },
  {
    key: 'routingPriority',
    getPath: '/settings/routing-priority',
    postPath: '/settings/routing-priority',
    pick: (body) => ({ routingPriority: body.routingPriority })
  },
  {
    key: 'routingMode',
    getPath: '/settings/routing-mode',
    postPath: '/settings/routing-mode',
    pick: (body) => ({ routingMode: body.routingMode })
  },
  {
    key: 'strictCodexCompatibility',
    getPath: '/settings/strict-codex-compatibility',
    postPath: '/settings/strict-codex-compatibility',
    pick: (body) => ({ strictCodexCompatibility: body.strictCodexCompatibility })
  },
  {
    key: 'strictTranslatorCompatibility',
    getPath: '/settings/strict-translator-compatibility',
    postPath: '/settings/strict-translator-compatibility',
    pick: (body) => ({ strictTranslatorCompatibility: body.strictTranslatorCompatibility })
  },
  {
    key: 'enableFreeModels',
    getPath: '/settings/enable-free-models',
    postPath: '/settings/enable-free-models',
    pick: (body) => ({ enableFreeModels: body.enableFreeModels })
  }
];

export async function snapshotSettings(baseUrl) {
  const snapshot = {};
  for (const item of SNAPSHOTS) {
    const response = await sendJsonRequest(baseUrl, { method: 'GET', path: item.getPath });
    if (response.status >= 400 || !response.json) {
      throw new Error(`Failed to snapshot ${item.key}: HTTP ${response.status}`);
    }
    snapshot[item.key] = item.pick(response.json);
  }
  return snapshot;
}

export async function restoreSettings(baseUrl, snapshot) {
  for (const item of SNAPSHOTS) {
    const body = snapshot?.[item.key];
    if (!body) continue;
    const response = await sendJsonRequest(baseUrl, {
      method: 'POST',
      path: item.postPath,
      body
    });
    if (response.status >= 400) {
      throw new Error(`Failed to restore ${item.key}: HTTP ${response.status}`);
    }
  }
}

export async function applySetupRequests(baseUrl, requests = []) {
  for (const request of requests) {
    const response = await sendJsonRequest(baseUrl, request);
    if (response.status >= 400) {
      throw new Error(`Setup request failed for ${request.path}: HTTP ${response.status}`);
    }
  }
}
