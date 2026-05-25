import { join } from 'path';

import { readJson, listConfigFiles } from './common.js';

function readRootArray(file, key) {
  const parsed = readJson(file, {});
  return Array.isArray(parsed?.[key]) ? parsed[key] : [];
}

export function inspectConfigState(configDir) {
  const files = listConfigFiles(configDir);
  const supervisorTasks = readRootArray(files.supervisorTasksFile, 'tasks');
  const conversations = readRootArray(files.conversationsFile, 'conversations');
  const runtimeSessions = readRootArray(files.runtimeSessionsFile, 'sessions');
  const approvalPolicies = readRootArray(files.approvalPoliciesFile, 'policies');
  const workspaces = readRootArray(join(configDir, 'assistant-core', 'workspaces.json'), 'workspaces');
  const assistantDomain = {
    persons: readRootArray(join(files.assistantDomainDir, 'persons.json'), 'persons'),
    projects: readRootArray(join(files.assistantDomainDir, 'projects.json'), 'projects'),
    tasks: readRootArray(join(files.assistantDomainDir, 'tasks.json'), 'tasks'),
    executions: readRootArray(join(files.assistantDomainDir, 'executions.json'), 'executions'),
    scheduledTasks: readRootArray(join(files.assistantDomainDir, 'scheduled-tasks.json'), 'scheduledTasks'),
    episodes: readRootArray(join(files.assistantDomainDir, 'episodes.json'), 'episodes')
  };

  return {
    files,
    supervisorTasks,
    conversations,
    runtimeSessions,
    approvalPolicies,
    workspaces,
    assistantDomain
  };
}

export function buildParitySummary(state) {
  return {
    supervisorTaskCount: state.supervisorTasks.length,
    conversationCount: state.conversations.length,
    runtimeSessionCount: state.runtimeSessions.length,
    approvalPolicyCount: state.approvalPolicies.length,
    assistantPersonCount: state.assistantDomain.persons.length,
    assistantProjectCount: state.assistantDomain.projects.length,
    assistantTaskCount: state.assistantDomain.tasks.length,
    assistantExecutionCount: state.assistantDomain.executions.length,
    assistantEpisodeCount: state.assistantDomain.episodes.length
  };
}
