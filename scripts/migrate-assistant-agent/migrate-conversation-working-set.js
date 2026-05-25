#!/usr/bin/env node

import { join } from 'path';

import { buildReportBase, parseArgs, printResult, writeJson } from './lib/common.js';
import { inspectConfigState } from './lib/inspect-config.js';
import { AssistantDomainBackfillPlanner } from './lib/domain-migration.js';

const args = parseArgs(process.argv.slice(2));
const state = inspectConfigState(args.configDir);
const planner = new AssistantDomainBackfillPlanner(state);
const migration = planner.applyConversationWorkingSetBackfill();
const nextState = planner.exportState();

const conversationsMissingAssistantDomain = state.conversations
  .filter((entry) => !(entry?.metadata?.assistantDomain && typeof entry.metadata.assistantDomain === 'object'))
  .map((entry) => ({
    conversationId: String(entry?.id || ''),
    channel: String(entry?.channel || '')
  }));

if (!args.dryRun) {
  writeJson(state.files.conversationsFile, { conversations: nextState.conversations });
  writeJson(join(state.files.assistantDomainDir, 'episodes.json'), { episodes: nextState.episodes });
}

const result = {
  ...buildReportBase({
    command: 'migrate-conversation-working-set',
    configDir: args.configDir,
    dryRun: args.dryRun
  }),
  status: 'ok',
  summary: args.dryRun
    ? 'Conversation working-set migration plan generated (dry-run).'
    : 'Conversation working-set migration completed.',
  totals: {
    conversations: state.conversations.length,
    missingAssistantDomainBefore: conversationsMissingAssistantDomain.length,
    conversationsPatched: migration.conversationsPatched,
    episodesCreated: migration.episodesCreated
  },
  missingAssistantDomain: conversationsMissingAssistantDomain,
  lines: [
    `conversations=${state.conversations.length}`,
    `missingAssistantDomainBefore=${conversationsMissingAssistantDomain.length}`,
    `conversationsPatched=${migration.conversationsPatched}`,
    `episodesCreated=${migration.episodesCreated}`
  ]
};

printResult(result, { json: args.json });
