#!/usr/bin/env node

import { buildReportBase, parseArgs, printResult } from './lib/common.js';
import { inspectConfigState } from './lib/inspect-config.js';
import { reconcileAssistantDomainLinks } from './lib/consistency-checks.js';

const args = parseArgs(process.argv.slice(2));
const state = inspectConfigState(args.configDir);
const {
  missingTaskLinks,
  missingExecutionLinks,
  missingPersonLinks
} = reconcileAssistantDomainLinks(state);

const result = {
  ...buildReportBase({
    command: 'reconcile-supervisor-task-vs-assistant-domain',
    configDir: args.configDir,
    dryRun: args.dryRun
  }),
  status: (missingTaskLinks.length === 0 && missingExecutionLinks.length === 0 && missingPersonLinks.length === 0) ? 'ok' : 'warning',
  summary: 'Supervisor task and assistant domain linkage reconciliation complete.',
  totals: {
    supervisorTasks: state.supervisorTasks.length,
    missingTaskLinks: missingTaskLinks.length,
    missingExecutionLinks: missingExecutionLinks.length,
    missingPersonLinks: missingPersonLinks.length
  },
  missingTaskLinks,
  missingExecutionLinks,
  missingPersonLinks,
  lines: [
    `supervisorTasks=${state.supervisorTasks.length}`,
    `missingTaskLinks=${missingTaskLinks.length}`,
    `missingExecutionLinks=${missingExecutionLinks.length}`,
    `missingPersonLinks=${missingPersonLinks.length}`
  ]
};

printResult(result, { json: args.json });
