import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { spawn } from 'child_process';

import { collectEvidence } from './logs-driver.js';
import { writeRunReport, writeScenarioArtifacts } from './report-writer.js';
import { snapshotSettings, restoreSettings, applySetupRequests } from './settings-driver.js';

const PROJECT_ROOT = resolve(process.cwd());
const SCENARIOS_ROOT = join(PROJECT_ROOT, 'tests', 'e2e', 'cli', 'scenarios');

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

function loadCliScenarios() {
  return walkJsonFiles(SCENARIOS_ROOT).map((filePath) => {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    return {
      enabled: true,
      assertions: [],
      ...raw,
      sourcePath: filePath
    };
  });
}

function parseArgs(argv) {
  const options = {
    baseUrl: 'http://127.0.0.1:8081',
    scenarioId: null,
    list: false
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
    }
  }
  return options;
}

function templateString(value, variables) {
  return String(value).replace(/\{\{(\w+)\}\}/g, (_, key) => (
    Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : ''
  ));
}

function applyTemplates(value, variables) {
  if (typeof value === 'string') return templateString(value, variables);
  if (Array.isArray(value)) return value.map((item) => applyTemplates(item, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, applyTemplates(item, variables)])
    );
  }
  return value;
}

function evaluateCliAssertions(assertions, context) {
  return (assertions || []).map((assertion) => {
    if (assertion.type === 'exit-code') {
      const passed = context.exitCode === assertion.expected;
      return {
        type: assertion.type,
        passed,
        message: passed ? `exit=${context.exitCode}` : `expected exit ${assertion.expected}, got ${context.exitCode}`
      };
    }
    if (assertion.type === 'stdout-contains') {
      const passed = context.stdout.includes(assertion.contains);
      return {
        type: assertion.type,
        passed,
        message: passed ? `stdout contains ${assertion.contains}` : `stdout missing ${assertion.contains}`
      };
    }
    if (assertion.type === 'stderr-contains') {
      const passed = context.stderr.includes(assertion.contains);
      return {
        type: assertion.type,
        passed,
        message: passed ? `stderr contains ${assertion.contains}` : `stderr missing ${assertion.contains}`
      };
    }
    if (assertion.type === 'request-log') {
      const expected = assertion.expected || {};
      const entry = (context.evidence.requestLogs || []).find((item) =>
        Object.entries(expected).every(([key, value]) => item?.[key] === value)
      );
      return {
        type: assertion.type,
        passed: Boolean(entry),
        message: entry ? `matched request log ${entry.id}` : 'no matching request log found'
      };
    }
    if (assertion.type === 'routing-decision') {
      const expected = assertion.expected || {};
      const entry = (context.evidence.routingDecisions || []).find((item) =>
        Object.entries(expected).every(([key, value]) => item?.[key] === value)
      );
      return {
        type: assertion.type,
        passed: Boolean(entry),
        message: entry ? `matched routing decision ${entry.at}` : 'no matching routing decision found'
      };
    }
    return {
      type: assertion.type,
      passed: false,
      message: `unsupported assertion type: ${assertion.type}`
    };
  });
}

function runCommand(command, { cwd, env, timeoutMs = 120000 } = {}) {
  return new Promise((resolvePromise) => {
    const isWindowsCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command.executable || '');
    const quoteForCmd = (value) => {
      const stringValue = String(value ?? '');
      if (stringValue.length === 0) return '""';
      return `"${stringValue.replace(/"/g, '""')}"`;
    };
    const executableForCmd = /[\s"]/i.test(command.executable || '')
      ? quoteForCmd(command.executable)
      : String(command.executable);
    const spawnExecutable = isWindowsCmd ? 'C:\\Windows\\System32\\cmd.exe' : command.executable;
    const spawnArgs = isWindowsCmd
      ? ['/d', '/s', '/c', [executableForCmd, ...(command.args || []).map(quoteForCmd)].join(' ')]
      : (command.args || []);

    const child = spawn(spawnExecutable, spawnArgs, {
      cwd: cwd || PROJECT_ROOT,
      env: { ...process.env, ...(env || {}) },
      shell: false
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    if (command.stdin) {
      child.stdin.write(command.stdin);
    }
    child.stdin.end();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        stdout,
        stderr,
        timedOut
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: -1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        timedOut
      });
    });
  });
}

export async function runCliScenarios(options = {}) {
  const scenarios = loadCliScenarios()
    .filter((scenario) => scenario.enabled !== false)
    .filter((scenario) => !options.scenarioId || scenario.id === options.scenarioId);

  if (scenarios.length === 0) {
    return {
      report: {
        runId: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        baseUrl: options.baseUrl,
        total: 0,
        passed: 0,
        failed: 0,
        results: []
      },
      files: null
    };
  }

  const startedAt = new Date().toISOString();
  const results = [];
  const snapshot = await snapshotSettings(options.baseUrl);
  const variables = {
    baseUrl: options.baseUrl,
    port: new URL(options.baseUrl).port,
    projectRoot: PROJECT_ROOT,
    ...(options.variables || {})
  };

  try {
    for (const scenario of scenarios) {
      // eslint-disable-next-line no-console
      console.log(`RUN  ${scenario.id}`);
      if (Array.isArray(scenario.setup?.requests) && scenario.setup.requests.length > 0) {
        await applySetupRequests(options.baseUrl, applyTemplates(scenario.setup.requests, variables));
      }
      const startedAtIso = new Date().toISOString();
      const commandResult = await runCommand(applyTemplates(scenario.command, variables), {
        cwd: applyTemplates(scenario.cwd || PROJECT_ROOT, variables),
        env: applyTemplates(scenario.env || {}, variables),
        timeoutMs: scenario.timeoutMs
      });
      const evidence = await collectEvidence(options.baseUrl, startedAtIso);
      const assertions = evaluateCliAssertions(scenario.assertions, {
        ...commandResult,
        evidence
      });
      const passed = assertions.every((item) => item.passed);
      const result = {
        id: scenario.id,
        name: scenario.name,
        status: passed ? 'passed' : 'failed',
        assertions,
        evidence,
        response: {
          status: commandResult.exitCode,
          durationMs: null,
          contentType: '',
          bodyPreview: commandResult.stdout.slice(0, 800),
          ssePreview: commandResult.stderr.slice(0, 800)
        },
        responseRaw: {
          status: commandResult.exitCode,
          headers: {},
          rawText: commandResult.stdout,
          json: null,
          events: []
        }
      };
      results.push(result);
      // eslint-disable-next-line no-console
      console.log(`${passed ? 'PASS' : 'FAIL'} ${scenario.id}`);
      for (const assertion of assertions) {
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

export { loadCliScenarios };

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenarios = loadCliScenarios();
  if (options.list) {
    if (scenarios.length === 0) {
      // eslint-disable-next-line no-console
      console.log('No CLI smoke scenarios found.');
      return;
    }
    for (const scenario of scenarios) {
      // eslint-disable-next-line no-console
      console.log(`${scenario.id}\t${scenario.enabled !== false ? 'enabled' : 'disabled'}\t${scenario.sourcePath}`);
    }
    return;
  }

  const { report, files } = await runCliScenarios(options);
  // eslint-disable-next-line no-console
  console.log(`\nSummary: ${report.passed}/${report.total} passed`);
  if (files?.latestPath) {
    // eslint-disable-next-line no-console
    console.log(`Report: ${files.latestPath}`);
  }
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
