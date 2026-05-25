#!/usr/bin/env node

import { join } from 'path';

import { buildReportBase, parseArgs, printResult, writeJson } from './lib/common.js';
import { buildParitySummary, inspectConfigState } from './lib/inspect-config.js';
import { AssistantDomainBackfillPlanner } from './lib/domain-migration.js';

const args = parseArgs(process.argv.slice(2));
const state = inspectConfigState(args.configDir);
const planner = new AssistantDomainBackfillPlanner(state);
const delta = planner.planBackfill();
const nextState = planner.exportState();
const summary = buildParitySummary({
  ...state,
  assistantDomain: {
    persons: nextState.persons,
    projects: nextState.projects,
    tasks: nextState.tasks,
    executions: nextState.executions,
    scheduledTasks: state.assistantDomain.scheduledTasks,
    episodes: nextState.episodes
  }
});

if (!args.dryRun) {
  const assistantDomainDir = join(args.configDir, 'assistant-domain');
  writeJson(join(assistantDomainDir, 'persons.json'), { persons: nextState.persons });
  writeJson(join(assistantDomainDir, 'projects.json'), { projects: nextState.projects });
  writeJson(join(assistantDomainDir, 'tasks.json'), { tasks: nextState.tasks });
  writeJson(join(assistantDomainDir, 'executions.json'), { executions: nextState.executions });
  writeJson(join(assistantDomainDir, 'episodes.json'), { episodes: nextState.episodes });
  writeJson(state.files.supervisorTasksFile, { tasks: nextState.supervisorTasks });
  writeJson(state.files.conversationsFile, { conversations: nextState.conversations });
  writeJson(state.files.runtimeSessionsFile, { sessions: nextState.runtimeSessions });
}

const result = {
  ...buildReportBase({
    command: 'backfill-person-project-task-execution',
    configDir: args.configDir,
    dryRun: args.dryRun
  }),
  status: 'ok',
  summary: args.dryRun
    ? 'Assistant domain backfill plan generated (dry-run).'
    : 'Assistant domain backfill completed.',
  counts: summary,
  delta,
  lines: [
    `dryRun=${String(args.dryRun)}`,
    `personsCreated=${delta.changes.personsCreated}`,
    `projectsCreated=${delta.changes.projectsCreated}`,
    `tasksCreated=${delta.changes.tasksCreated}`,
    `executionsCreated=${delta.changes.executionsCreated}`,
    `episodesCreated=${delta.changes.episodesCreated}`,
    `conversationsPatched=${delta.changes.conversationsPatched}`
  ]
};

printResult(result, { json: args.json });
