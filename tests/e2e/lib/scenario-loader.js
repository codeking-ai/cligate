import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const PROJECT_ROOT = resolve(process.cwd());
const SCENARIOS_ROOT = join(PROJECT_ROOT, 'tests', 'e2e', 'protocol', 'scenarios');

function walkJsonFiles(dir) {
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const nextPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsonFiles(nextPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(nextPath);
    }
  }
  return files.sort();
}

function validateScenario(raw, sourcePath) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Scenario in ${sourcePath} must be a JSON object`);
  }
  if (!raw.id || typeof raw.id !== 'string') {
    throw new Error(`Scenario in ${sourcePath} is missing string id`);
  }
  if (!raw.name || typeof raw.name !== 'string') {
    throw new Error(`Scenario ${raw.id} is missing string name`);
  }
  if (!raw.request || typeof raw.request !== 'object') {
    throw new Error(`Scenario ${raw.id} is missing request definition`);
  }
  if (!raw.request.path || typeof raw.request.path !== 'string') {
    throw new Error(`Scenario ${raw.id} request.path must be a string`);
  }
  if (!Array.isArray(raw.assertions) || raw.assertions.length === 0) {
    throw new Error(`Scenario ${raw.id} must define at least one assertion`);
  }

  return {
    kind: 'protocol',
    tags: [],
    setup: { requests: [] },
    ...raw,
    request: {
      method: 'POST',
      headers: {},
      ...raw.request
    },
    sourcePath
  };
}

export function loadAllProtocolScenarios() {
  return walkJsonFiles(SCENARIOS_ROOT).map((filePath) => {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    return validateScenario(raw, filePath);
  });
}

export function getProtocolScenarioById(id) {
  return loadAllProtocolScenarios().find((scenario) => scenario.id === id) || null;
}

export function listProtocolScenarios() {
  return loadAllProtocolScenarios().map((scenario) => ({
    id: scenario.id,
    name: scenario.name,
    client: scenario.client || 'unknown',
    entry: scenario.entry || scenario.request?.path || '',
    tags: scenario.tags || [],
    sourcePath: scenario.sourcePath
  }));
}
