#!/usr/bin/env node

import { buildReportBase, parseArgs, printResult } from './lib/common.js';
import { buildParitySummary, inspectConfigState } from './lib/inspect-config.js';
import { verifyAssistantDomainConsistency } from './lib/consistency-checks.js';

const args = parseArgs(process.argv.slice(2));
const state = inspectConfigState(args.configDir);
const counts = buildParitySummary(state);

const issues = [];
if (counts.supervisorTaskCount > 0 && counts.assistantTaskCount === 0) {
  issues.push('supervisor tasks exist but assistant tasks are empty');
}
if (counts.runtimeSessionCount > 0 && counts.assistantExecutionCount === 0) {
  issues.push('runtime sessions exist but assistant executions are empty');
}
if (counts.conversationCount > 0 && counts.assistantPersonCount === 0) {
  issues.push('conversations exist but assistant persons are empty');
}
issues.push(...verifyAssistantDomainConsistency(state));

const result = {
  ...buildReportBase({
    command: 'verify-person-project-task-execution',
    configDir: args.configDir,
    dryRun: args.dryRun
  }),
  status: issues.length === 0 ? 'ok' : 'warning',
  summary: issues.length === 0
    ? 'Assistant domain verification passed at summary level.'
    : 'Assistant domain verification found gaps.',
  counts,
  issues,
  lines: issues.length === 0
    ? [
        `supervisorTasks=${counts.supervisorTaskCount}`,
        `assistantTasks=${counts.assistantTaskCount}`,
        `assistantExecutions=${counts.assistantExecutionCount}`
      ]
    : issues
};

printResult(result, { json: args.json });
