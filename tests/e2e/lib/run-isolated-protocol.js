import { runProtocolScenarios } from './scenario-runner.js';
import {
  parseIsolatedArgs,
  prepareIsolatedConfig,
  resolvePort,
  startIsolatedServer,
  stopIsolatedServer,
  waitForHealth
} from './isolated-server.js';

async function main() {
  const options = parseIsolatedArgs(process.argv.slice(2));
  options.basePort = await resolvePort(options.basePort);
  const authFiles = prepareIsolatedConfig(options);
  const child = startIsolatedServer(options, authFiles);
  const baseUrl = `http://127.0.0.1:${options.basePort}`;

  try {
    console.log(`Using isolated base URL: ${baseUrl}`);
    await waitForHealth(baseUrl, options.startupTimeoutMs);
    const { report, files } = await runProtocolScenarios({
      baseUrl,
      scenarioId: options.scenarioId,
      allowLiveMutations: options.allowLiveMutations
    });
    console.log(`\nSummary: ${report.passed}/${report.total} passed`);
    console.log(`Report: ${files.latestPath}`);
    process.exitCode = report.failed > 0 ? 1 : 0;
  } finally {
    await stopIsolatedServer(child);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
