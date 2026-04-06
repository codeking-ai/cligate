import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const REPORT_DIR = resolve(process.cwd(), 'tests', 'reports');
const ARTIFACTS_DIR = join(REPORT_DIR, 'artifacts');

function ensureDir() {
  mkdirSync(REPORT_DIR, { recursive: true });
}

function safeName(value) {
  return String(value).replace(/[:.]/g, '-');
}

export function writeRunReport(report) {
  ensureDir();
  const latestPath = join(REPORT_DIR, 'latest.json');
  const timestampPath = join(REPORT_DIR, `${safeName(report.completedAt || report.startedAt || new Date().toISOString())}.json`);
  const serialized = JSON.stringify(report, null, 2);
  writeFileSync(latestPath, serialized, 'utf8');
  writeFileSync(timestampPath, serialized, 'utf8');
  return { latestPath, timestampPath };
}

export function writeScenarioArtifacts(runId, scenarioResult) {
  const scenarioDir = join(ARTIFACTS_DIR, safeName(runId), safeName(scenarioResult.id));
  mkdirSync(scenarioDir, { recursive: true });

  const responseArtifact = {
    status: scenarioResult.responseRaw?.status ?? null,
    headers: scenarioResult.responseRaw?.headers ?? {},
    rawText: scenarioResult.responseRaw?.rawText ?? '',
    json: scenarioResult.responseRaw?.json ?? null,
    events: scenarioResult.responseRaw?.events ?? []
  };
  writeFileSync(join(scenarioDir, 'response.json'), JSON.stringify(responseArtifact, null, 2), 'utf8');
  writeFileSync(join(scenarioDir, 'assertions.json'), JSON.stringify(scenarioResult.assertions || [], null, 2), 'utf8');
  writeFileSync(join(scenarioDir, 'request-logs.json'), JSON.stringify(scenarioResult.evidence?.requestLogs || [], null, 2), 'utf8');
  writeFileSync(join(scenarioDir, 'routing-decisions.json'), JSON.stringify(scenarioResult.evidence?.routingDecisions || [], null, 2), 'utf8');

  return scenarioDir;
}
