#!/usr/bin/env node

import { buildReportBase, parseArgs, printResult, writeJson } from './lib/common.js';
import { inspectConfigState } from './lib/inspect-config.js';
import { AssistantDomainBackfillPlanner } from './lib/domain-migration.js';

const args = parseArgs(process.argv.slice(2));
const state = inspectConfigState(args.configDir);
const planner = new AssistantDomainBackfillPlanner(state);
planner.planBackfill();
const migration = planner.applyApprovalPolicyScopeMigration();
const nextState = planner.exportState();

const legacyScopeCounts = state.approvalPolicies.reduce((acc, entry) => {
  const scope = String(entry?.scope || '').trim() || 'unknown';
  acc[scope] = Number(acc[scope] || 0) + 1;
  return acc;
}, {});

if (!args.dryRun) {
  writeJson(state.files.approvalPoliciesFile, { policies: nextState.approvalPolicies });
}

const result = {
  ...buildReportBase({
    command: 'migrate-approval-policy-scope',
    configDir: args.configDir,
    dryRun: args.dryRun
  }),
  status: 'ok',
  summary: args.dryRun
    ? 'Approval policy scope migration plan generated (dry-run).'
    : 'Approval policy scope migration completed.',
  totals: {
    policies: state.approvalPolicies.length,
    migratedPolicies: migration.migratedPolicies,
    unresolvedPolicies: migration.unresolvedPolicies
  },
  legacyScopeCounts,
  lines: [
    ...(Object.keys(legacyScopeCounts).length > 0
      ? Object.entries(legacyScopeCounts).map(([scope, count]) => `${scope}=${count}`)
      : ['no approval policies found']),
    `migratedPolicies=${migration.migratedPolicies}`,
    `unresolvedPolicies=${migration.unresolvedPolicies}`
  ]
};

printResult(result, { json: args.json });
