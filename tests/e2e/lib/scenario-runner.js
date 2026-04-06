import { loadAllProtocolScenarios, getProtocolScenarioById, listProtocolScenarios } from './scenario-loader.js';
import { sendJsonRequest, sendSseRequest } from './http-client.js';
import { snapshotSettings, restoreSettings, applySetupRequests } from './settings-driver.js';
import { collectEvidence } from './logs-driver.js';
import { evaluateAssertions, summarizeResponseForReport } from './assertions.js';
import { writeRunReport, writeScenarioArtifacts } from './report-writer.js';

function parseArgs(argv) {
  const options = {
    baseUrl: 'http://127.0.0.1:8081',
    scenarioId: null,
    list: false,
    allowLiveMutations: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base-url') {
      options.baseUrl = argv[++i];
      continue;
    }
    if (arg === '--scenario') {
      options.scenarioId = argv[++i];
      continue;
    }
    if (arg === '--list') {
      options.list = true;
      continue;
    }
    if (arg === '--allow-live-mutations') {
      options.allowLiveMutations = true;
    }
  }

  return options;
}

async function runPreflightChecks(baseUrl, options) {
  const [routingMode, appRouting, recentLogs] = await Promise.all([
    sendJsonRequest(baseUrl, { method: 'GET', path: '/settings/routing-mode' }),
    sendJsonRequest(baseUrl, { method: 'GET', path: '/settings/app-routing' }),
    sendJsonRequest(baseUrl, { method: 'GET', path: '/api/logs' })
  ]);

  const mode = routingMode.json?.routingMode || 'automatic';
  const codexBindingEnabled = appRouting.json?.appRouting?.codex?.enabled === true;
  const recentRuntimeLogs = Array.isArray(recentLogs.json?.logs) ? recentLogs.json.logs : [];
  const hasVeryRecentCodexActivity = recentRuntimeLogs.some((entry) => {
    const message = String(entry?.message || '');
    if (!message.includes('[Codex]') && !message.includes('[Codex Proxy]')) return false;
    const timestamp = entry?.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (Number.isNaN(timestamp)) return true;
    return (Date.now() - timestamp) < 2 * 60 * 1000;
  });

  if (!options.allowLiveMutations && (mode === 'app-assigned' || codexBindingEnabled || hasVeryRecentCodexActivity)) {
    throw new Error(
      [
        'Refusing to mutate settings on an actively used live service.',
        `routingMode=${mode}`,
        `codexBindingEnabled=${codexBindingEnabled}`,
        `recentCodexActivity=${hasVeryRecentCodexActivity}`,
        'Use a dedicated test instance, or rerun with --allow-live-mutations if you intentionally want to test against the live service.'
      ].join(' ')
    );
  }
}

function pickScenarios(options) {
  if (options.scenarioId) {
    const scenario = getProtocolScenarioById(options.scenarioId);
    if (!scenario) {
      throw new Error(`Scenario not found: ${options.scenarioId}`);
    }
    return [scenario];
  }
  return loadAllProtocolScenarios();
}

async function executeScenario(baseUrl, scenario) {
  const startedAtIso = new Date().toISOString();
  if (Array.isArray(scenario.setup?.requests) && scenario.setup.requests.length > 0) {
    await applySetupRequests(baseUrl, scenario.setup.requests);
  }

  const response = scenario.request.body?.stream === true
    ? await sendSseRequest(baseUrl, scenario.request)
    : await sendJsonRequest(baseUrl, scenario.request);
  const evidence = await collectEvidence(baseUrl, startedAtIso);
  const assertionResults = evaluateAssertions(scenario.assertions, {
    scenario,
    response,
    evidence
  });
  const passed = assertionResults.every((item) => item.passed);

  return {
    id: scenario.id,
    name: scenario.name,
    client: scenario.client || 'unknown',
    entry: scenario.entry || scenario.request.path,
    status: passed ? 'passed' : 'failed',
    response: summarizeResponseForReport(response),
    responseRaw: response,
    assertions: assertionResults,
    evidence
  };
}

export async function runProtocolScenarios(options = {}) {
  const health = await sendJsonRequest(options.baseUrl, { method: 'GET', path: '/health' });
  if (health.status >= 400) {
    throw new Error(`Health check failed for ${options.baseUrl}: HTTP ${health.status}`);
  }
  await runPreflightChecks(options.baseUrl, options);

  const scenarios = pickScenarios(options);
  const startedAt = new Date().toISOString();
  const snapshot = await snapshotSettings(options.baseUrl);
  const results = [];

  try {
    for (const scenario of scenarios) {
      // eslint-disable-next-line no-console
      console.log(`RUN  ${scenario.id}`);
      const result = await executeScenario(options.baseUrl, scenario);
      results.push(result);
      // eslint-disable-next-line no-console
      console.log(`${result.status === 'passed' ? 'PASS' : 'FAIL'} ${scenario.id}`);
      for (const assertion of result.assertions) {
        if (assertion.passed) continue;
        // eslint-disable-next-line no-console
        console.log(`  - ${assertion.message}`);
      }
    }
  } finally {
    await restoreSettings(options.baseUrl, snapshot);
  }

  const completedAt = new Date().toISOString();
  const runId = completedAt;
  for (const result of results) {
    if (result.status !== 'failed') continue;
    result.artifactsDir = writeScenarioArtifacts(runId, result);
  }
  const report = {
    runId,
    startedAt,
    completedAt,
    baseUrl: options.baseUrl,
    total: results.length,
    passed: results.filter((item) => item.status === 'passed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    results
  };
  const files = writeRunReport(report);
  return { report, files };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const scenario of listProtocolScenarios()) {
      // eslint-disable-next-line no-console
      console.log(`${scenario.id}\t${scenario.client}\t${scenario.entry}`);
    }
    return;
  }

  const { report, files } = await runProtocolScenarios(options);
  // eslint-disable-next-line no-console
  console.log(`\nSummary: ${report.passed}/${report.total} passed`);
  // eslint-disable-next-line no-console
  console.log(`Report: ${files.latestPath}`);
  process.exitCode = report.failed > 0 ? 1 : 0;
}

const invokedPath = process.argv[1] ? new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).pathname : '';
if (import.meta.url.endsWith(invokedPath)) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
