import path from 'path';

import {
  appendUniqueId,
  createEpisode,
  createExecution,
  createPerson,
  createProject,
  createTask,
  normalizeConversationWorkingSet,
  normalizeRecentMessages
} from '../../../src/assistant-core/domain/models.js';
import { normalizeSupervisorTaskMemory, listSupervisorTaskRecords } from '../../../src/agent-orchestrator/supervisor-task-memory.js';
import { normalizeWorkspaceRef } from '../../../src/assistant-core/workspace-store.js';
import { normalizeScope } from '../../../src/assistant-core/scope-resolver.js';

function toText(value) {
  return String(value || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeBasename(value) {
  const normalized = normalizeWorkspaceRef(value);
  if (!normalized) return '';
  return path.basename(normalized).trim() || normalized;
}

function dedupeById(records = []) {
  const seen = new Set();
  const result = [];
  for (const record of records) {
    const id = toText(record?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(record);
  }
  return result;
}

function buildPersonKey(conversation = {}) {
  return `${toText(conversation?.channel).toLowerCase()}::${toText(conversation?.externalUserId) || 'anonymous-user'}`;
}

function resolveConversationTitle(conversation = {}) {
  return toText(conversation?.title) || `${toText(conversation?.externalUserId) || 'conversation'}`;
}

function mapExecutionStatus(value = '') {
  const normalized = toText(value).toLowerCase();
  if (normalized === 'starting') return 'spawning';
  if (normalized === 'running') return 'running';
  if (normalized === 'waiting_approval') return 'waiting_approval';
  if (normalized === 'waiting_user') return 'waiting_user';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'cancelled') return 'cancelled';
  if (normalized === 'completed') return 'done';
  if (normalized === 'ready') return 'ready';
  return 'spawning';
}

function mapTaskLifecycle(value = '') {
  const normalized = toText(value).toLowerCase();
  if (normalized === 'completed') return 'completed';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'cancelled') return 'cancelled';
  if (normalized === 'paused') return 'paused';
  return 'open';
}

function resolveTaskCompletionCriteria(task = {}) {
  const text = `${toText(task?.title)} ${toText(task?.goal)} ${toText(task?.intent)}`.toLowerCase();
  return /(实现|修复|fix|implement|build|补|新增|add|change|update)/i.test(text)
    ? 'deliverable_completed'
    : 'explicit_user_close';
}

function buildTaskGoal(task = {}) {
  return toText(task?.goal || task?.intent || task?.title);
}

function buildExecutionRole(task = {}) {
  return toText(task?.metadata?.executionRole || task?.metadata?.role || 'primary');
}

function mergeMetadata(current, patch) {
  return {
    ...((current && typeof current === 'object') ? current : {}),
    ...((patch && typeof patch === 'object') ? patch : {})
  };
}

export class AssistantDomainBackfillPlanner {
  constructor(state) {
    this.state = state;
    this.persons = dedupeById(state.assistantDomain.persons);
    this.projects = dedupeById(state.assistantDomain.projects);
    this.tasks = dedupeById(state.assistantDomain.tasks);
    this.executions = dedupeById(state.assistantDomain.executions);
    this.episodes = dedupeById(state.assistantDomain.episodes);

    this.supervisorTasks = (Array.isArray(state.supervisorTasks) ? state.supervisorTasks : []).map((entry) => ({
      ...entry,
      metadata: mergeMetadata(entry?.metadata, {})
    }));
    this.conversations = (Array.isArray(state.conversations) ? state.conversations : []).map((entry) => ({
      ...entry,
      metadata: mergeMetadata(entry?.metadata, {})
    }));
    this.runtimeSessions = (Array.isArray(state.runtimeSessions) ? state.runtimeSessions : []).map((entry) => ({
      ...entry,
      metadata: mergeMetadata(entry?.metadata, {})
    }));
    this.approvalPolicies = (Array.isArray(state.approvalPolicies) ? state.approvalPolicies : []).map((entry) => ({
      ...entry,
      metadata: mergeMetadata(entry?.metadata, {})
    }));
    this.workspaces = Array.isArray(state.workspaces) ? state.workspaces : [];

    this.personByKey = new Map();
    this.projectByOwnerAndCwd = new Map();
    this.taskBySupervisorTaskId = new Map();
    this.executionByRuntimeSessionId = new Map();
    this.executionBySupervisorTaskId = new Map();
    this.conversationById = new Map();
    this.runtimeSessionById = new Map();
    this.workspaceByRef = new Map();

    for (const person of this.persons) {
      for (const identity of Array.isArray(person?.externalIdentities) ? person.externalIdentities : []) {
        this.personByKey.set(`${toText(identity?.channel).toLowerCase()}::${toText(identity?.externalUserId)}`, person);
      }
    }

    for (const project of this.projects) {
      const cwdKey = `${toText(project?.ownerPersonId)}::${normalizeWorkspaceRef(project?.cwd)}`;
      if (toText(project?.ownerPersonId) && normalizeWorkspaceRef(project?.cwd)) {
        this.projectByOwnerAndCwd.set(cwdKey, project);
      }
    }

    for (const task of this.tasks) {
      const supervisorTaskId = toText(task?.metadata?.supervisorTaskId);
      if (supervisorTaskId) {
        this.taskBySupervisorTaskId.set(supervisorTaskId, task);
      }
    }

    for (const execution of this.executions) {
      const runtimeSessionId = toText(execution?.currentRuntimeSessionId);
      const supervisorTaskId = toText(execution?.metadata?.supervisorTaskId);
      if (runtimeSessionId) {
        this.executionByRuntimeSessionId.set(runtimeSessionId, execution);
      }
      if (supervisorTaskId) {
        this.executionBySupervisorTaskId.set(supervisorTaskId, execution);
      }
    }

    for (const conversation of this.conversations) {
      this.conversationById.set(toText(conversation?.id), conversation);
    }
    for (const session of this.runtimeSessions) {
      this.runtimeSessionById.set(toText(session?.id), session);
    }
    for (const workspace of this.workspaces) {
      const ref = normalizeWorkspaceRef(workspace?.workspaceRef);
      if (ref) {
        this.workspaceByRef.set(ref, workspace);
      }
    }
  }

  ensurePersonForConversation(conversation) {
    const existingPersonId = toText(conversation?.metadata?.assistantDomain?.personId);
    if (existingPersonId) {
      const existing = this.persons.find((entry) => toText(entry?.id) === existingPersonId);
      if (existing) return existing;
    }

    const personKey = buildPersonKey(conversation);
    const existing = this.personByKey.get(personKey);
    if (existing) {
      return existing;
    }

    const person = createPerson({
      externalIdentities: [{
        channel: toText(conversation?.channel).toLowerCase(),
        externalUserId: toText(conversation?.externalUserId) || 'anonymous-user'
      }]
    });
    this.persons.push(person);
    this.personByKey.set(personKey, person);

    const miscProject = createProject({
      ownerPersonId: person.id,
      name: 'misc',
      aliases: ['misc'],
      kind: 'misc',
      summary: 'Default catch-all project for ad hoc tasks.'
    });
    this.projects.push(miscProject);
    this.projectByOwnerAndCwd.set(`${person.id}::`, miscProject);

    const savedPerson = createPerson({
      ...person,
      miscProjectId: miscProject.id,
      knownProjectIds: appendUniqueId(person.knownProjectIds, miscProject.id),
      createdAt: person.createdAt
    });
    this._replaceRecord(this.persons, savedPerson);
    this.personByKey.set(personKey, savedPerson);
    return savedPerson;
  }

  ensureMiscProject(person) {
    const existing = this.projects.find((entry) => (
      toText(entry?.ownerPersonId) === toText(person?.id)
      && toText(entry?.kind) === 'misc'
    ));
    if (existing) return existing;
    const project = createProject({
      ownerPersonId: person.id,
      name: 'misc',
      aliases: ['misc'],
      kind: 'misc',
      summary: 'Default catch-all project for ad hoc tasks.'
    });
    this.projects.push(project);
    this.projectByOwnerAndCwd.set(`${person.id}::`, project);
    this._replaceRecord(this.persons, createPerson({
      ...person,
      miscProjectId: project.id,
      knownProjectIds: appendUniqueId(person.knownProjectIds, project.id),
      createdAt: person.createdAt
    }));
    return project;
  }

  ensureProjectForTask(person, supervisorTask, session) {
    const metadata = mergeMetadata(supervisorTask?.metadata, {});
    const existingProjectId = toText(metadata.assistantProjectId);
    if (existingProjectId) {
      const existing = this.projects.find((entry) => toText(entry?.id) === existingProjectId);
      if (existing) return existing;
    }

    const cwd = normalizeWorkspaceRef(
      supervisorTask?.cwd
      || supervisorTask?.metadata?.cwd
      || session?.cwd
      || ''
    );

    if (!cwd) {
      return this.ensureMiscProject(person);
    }

    const ownerAndCwdKey = `${person.id}::${cwd}`;
    const existing = this.projectByOwnerAndCwd.get(ownerAndCwdKey);
    if (existing) return existing;

    const workspace = this.workspaceByRef.get(cwd);
    const project = createProject({
      ownerPersonId: person.id,
      name: toText(workspace?.name) || normalizeBasename(cwd) || 'workspace',
      aliases: Array.isArray(workspace?.aliases) ? workspace.aliases : [],
      kind: 'code_project',
      cwd,
      summary: toText(workspace?.summary),
      preferredProviders: [toText(session?.provider || supervisorTask?.executorStrategy)].filter(Boolean),
      metadata: {
        workspaceId: toText(workspace?.id || supervisorTask?.workspaceId || supervisorTask?.metadata?.workspaceId),
        migratedFromWorkspace: Boolean(workspace?.id),
        defaultRuntimeProvider: toText(workspace?.defaultRuntimeProvider)
      }
    });
    this.projects.push(project);
    this.projectByOwnerAndCwd.set(ownerAndCwdKey, project);

    this._replaceRecord(this.persons, createPerson({
      ...person,
      knownProjectIds: appendUniqueId(person.knownProjectIds, project.id),
      miscProjectId: toText(person?.miscProjectId),
      createdAt: person.createdAt
    }));
    return project;
  }

  ensureTaskForSupervisorTask(person, project, supervisorTask, conversation, session) {
    const metadata = mergeMetadata(supervisorTask?.metadata, {});
    const existingTaskId = toText(metadata.assistantTaskId);
    if (existingTaskId) {
      const existing = this.tasks.find((entry) => toText(entry?.id) === existingTaskId);
      if (existing) return existing;
    }

    const fromIndex = this.taskBySupervisorTaskId.get(toText(supervisorTask?.id));
    if (fromIndex) return fromIndex;

    const task = createTask({
      ownerPersonId: person.id,
      projectId: project.id,
      title: toText(supervisorTask?.title) || resolveConversationTitle(conversation),
      goal: buildTaskGoal(supervisorTask),
      summary: toText(supervisorTask?.summary || supervisorTask?.result),
      completionCriteria: resolveTaskCompletionCriteria(supervisorTask),
      lifecycleState: mapTaskLifecycle(supervisorTask?.status),
      lastConversationId: toText(supervisorTask?.lastConversationId || supervisorTask?.conversationId || conversation?.id),
      activeExecutionIds: [],
      allExecutionIds: [],
      idleAutoArchiveDays: project.kind === 'misc' ? 30 : 180,
      assistantRationale: {
        routeReason: 'phase1_backfill_from_supervisor_task',
        candidateEvidence: [
          `supervisorTaskId:${toText(supervisorTask?.id)}`,
          `runtimeSessionId:${toText(session?.id)}`
        ]
      },
      metadata: {
        supervisorTaskId: toText(supervisorTask?.id),
        workspaceId: toText(supervisorTask?.workspaceId || supervisorTask?.metadata?.workspaceId),
        originKind: toText(supervisorTask?.metadata?.originKind)
      }
    });
    this.tasks.push(task);
    this.taskBySupervisorTaskId.set(toText(supervisorTask?.id), task);
    return task;
  }

  ensureExecutionForSupervisorTask(person, task, supervisorTask, session) {
    const metadata = mergeMetadata(supervisorTask?.metadata, {});
    const existingExecutionId = toText(metadata.assistantExecutionId);
    if (existingExecutionId) {
      const existing = this.executions.find((entry) => toText(entry?.id) === existingExecutionId);
      if (existing) return existing;
    }

    const sessionId = toText(session?.id || supervisorTask?.metadata?.runtimeSessionId || supervisorTask?.primaryExecutionId);
    if (sessionId && this.executionByRuntimeSessionId.has(sessionId)) {
      return this.executionByRuntimeSessionId.get(sessionId);
    }
    if (this.executionBySupervisorTaskId.has(toText(supervisorTask?.id))) {
      return this.executionBySupervisorTaskId.get(toText(supervisorTask?.id));
    }

    const execution = createExecution({
      taskId: task.id,
      ownerPersonId: person.id,
      provider: toText(session?.provider || supervisorTask?.executorStrategy || supervisorTask?.metadata?.provider || 'codex'),
      role: buildExecutionRole(supervisorTask),
      objective: buildTaskGoal(supervisorTask),
      currentRuntimeSessionId: sessionId,
      runtimeSessionHistory: sessionId ? [sessionId] : [],
      providerSessionId: toText(session?.providerSessionId),
      status: mapExecutionStatus(session?.status || supervisorTask?.status),
      lastTurnSummary: toText(session?.summary || supervisorTask?.summary || supervisorTask?.result),
      lastInputPreview: buildTaskGoal(supervisorTask),
      lastTurnAt: toText(session?.updatedAt || supervisorTask?.updatedAt || supervisorTask?.lastUpdateAt),
      lastMeaningfulProgressAt: toText(session?.updatedAt || supervisorTask?.updatedAt || supervisorTask?.lastUpdateAt),
      assistantRationale: {
        routeReason: 'phase1_backfill_from_runtime_session',
        candidateEvidence: [
          `supervisorTaskId:${toText(supervisorTask?.id)}`,
          `runtimeSessionId:${sessionId}`
        ]
      },
      metadata: {
        supervisorTaskId: toText(supervisorTask?.id)
      }
    });
    this.executions.push(execution);
    if (sessionId) {
      this.executionByRuntimeSessionId.set(sessionId, execution);
    }
    this.executionBySupervisorTaskId.set(toText(supervisorTask?.id), execution);
    return execution;
  }

  appendEpisodeOnce({
    kind,
    personId = '',
    projectId = '',
    taskId = '',
    executionId = '',
    runtimeSessionId = '',
    conversationId = '',
    payload = {},
    metadata = {}
  } = {}) {
    const migrationKey = toText(metadata?.migrationKey);
    if (migrationKey && this.episodes.some((entry) => toText(entry?.metadata?.migrationKey) === migrationKey)) {
      return null;
    }
    const episode = createEpisode({
      kind,
      personId,
      projectId,
      taskId,
      executionId,
      runtimeSessionId,
      conversationId,
      payload,
      metadata
    });
    this.episodes.push(episode);
    return episode;
  }

  planBackfill() {
    const changes = {
      personsCreated: 0,
      projectsCreated: 0,
      tasksCreated: 0,
      executionsCreated: 0,
      episodesCreated: 0,
      supervisorTasksLinked: 0,
      runtimeSessionsLinked: 0,
      conversationsPatched: 0
    };

    const originalCounts = {
      persons: this.persons.length,
      projects: this.projects.length,
      tasks: this.tasks.length,
      executions: this.executions.length,
      episodes: this.episodes.length
    };

    for (const conversation of this.conversations) {
      const before = this.persons.length;
      const person = this.ensurePersonForConversation(conversation);
      const miscBefore = this.projects.length;
      this.ensureMiscProject(person);
      if (this.persons.length > before) changes.personsCreated += this.persons.length - before;
      if (this.projects.length > miscBefore) changes.projectsCreated += this.projects.length - miscBefore;
    }

    for (const supervisorTask of this.supervisorTasks) {
      const conversationId = toText(supervisorTask?.lastConversationId || supervisorTask?.conversationId);
      const conversation = this.conversationById.get(conversationId) || null;
      if (!conversation) continue;
      const sessionId = toText(
        supervisorTask?.metadata?.runtimeSessionId
        || supervisorTask?.metadata?.latestExecutionId
        || supervisorTask?.primaryExecutionId
      );
      const session = this.runtimeSessionById.get(sessionId) || null;

      const personsBefore = this.persons.length;
      const projectsBefore = this.projects.length;
      const tasksBefore = this.tasks.length;
      const executionsBefore = this.executions.length;

      const person = this.ensurePersonForConversation(conversation);
      const project = this.ensureProjectForTask(person, supervisorTask, session);
      const task = this.ensureTaskForSupervisorTask(person, project, supervisorTask, conversation, session);
      const execution = this.ensureExecutionForSupervisorTask(person, task, supervisorTask, session);

      changes.personsCreated += this.persons.length - personsBefore;
      changes.projectsCreated += this.projects.length - projectsBefore;
      changes.tasksCreated += this.tasks.length - tasksBefore;
      changes.executionsCreated += this.executions.length - executionsBefore;

      const nextTask = createTask({
        ...task,
        allExecutionIds: appendUniqueId(task.allExecutionIds, execution.id),
        activeExecutionIds: mapTaskLifecycle(supervisorTask?.status) === 'open'
          ? appendUniqueId(task.activeExecutionIds, execution.id)
          : task.activeExecutionIds,
        lastConversationId: toText(supervisorTask?.lastConversationId || supervisorTask?.conversationId || conversation?.id),
        summary: toText(task.summary || supervisorTask?.summary || supervisorTask?.result),
        createdAt: task.createdAt
      });
      this._replaceRecord(this.tasks, nextTask);
      this.taskBySupervisorTaskId.set(toText(supervisorTask?.id), nextTask);

      const projectIsTerminal = ['completed', 'failed', 'cancelled'].includes(nextTask.lifecycleState);
      const nextProject = createProject({
        ...project,
        activeTaskIds: projectIsTerminal
          ? project.activeTaskIds.filter((entry) => entry !== nextTask.id)
          : appendUniqueId(project.activeTaskIds, nextTask.id),
        archivedTaskIds: projectIsTerminal
          ? appendUniqueId(project.archivedTaskIds, nextTask.id)
          : project.archivedTaskIds.filter((entry) => entry !== nextTask.id),
        lastConversationId: toText(conversation?.id || project.lastConversationId),
        summary: toText(project.summary),
        createdAt: project.createdAt
      });
      this._replaceRecord(this.projects, nextProject);
      this.projectByOwnerAndCwd.set(`${nextProject.ownerPersonId}::${normalizeWorkspaceRef(nextProject.cwd)}`, nextProject);

      const updatedPerson = this.persons.find((entry) => toText(entry?.id) === person.id) || person;
      this._replaceRecord(this.persons, createPerson({
        ...updatedPerson,
        miscProjectId: toText(updatedPerson?.miscProjectId || person?.miscProjectId),
        knownProjectIds: appendUniqueId(updatedPerson.knownProjectIds, nextProject.id),
        createdAt: updatedPerson.createdAt || person.createdAt
      }));

      const patchedSupervisorTask = {
        ...supervisorTask,
        metadata: mergeMetadata(supervisorTask.metadata, {
          assistantPersonId: person.id,
          assistantProjectId: nextProject.id,
          assistantTaskId: nextTask.id,
          assistantExecutionId: execution.id
        })
      };
      this._replaceLegacyRecord(this.supervisorTasks, patchedSupervisorTask);
      changes.supervisorTasksLinked += 1;

      if (session?.id) {
        const patchedSession = {
          ...session,
          metadata: mergeMetadata(session.metadata, {
            assistantPersonId: person.id,
            assistantProjectId: nextProject.id,
            assistantTaskId: nextTask.id,
            assistantExecutionId: execution.id
          })
        };
        this._replaceLegacyRecord(this.runtimeSessions, patchedSession);
        this.runtimeSessionById.set(toText(session.id), patchedSession);
        changes.runtimeSessionsLinked += 1;
      }

      const createdEpisode = this.appendEpisodeOnce({
        kind: 'migration.backfilled_supervisor_task',
        personId: person.id,
        projectId: nextProject.id,
        taskId: nextTask.id,
        executionId: execution.id,
        runtimeSessionId: toText(session?.id),
        conversationId: toText(conversation?.id),
        payload: {
          supervisorTaskId: toText(supervisorTask?.id),
          title: toText(supervisorTask?.title),
          provider: toText(session?.provider || execution.provider),
          status: toText(supervisorTask?.status)
        },
        metadata: {
          migrationKey: `supervisor:${toText(supervisorTask?.id)}`
        }
      });
      if (createdEpisode) {
        changes.episodesCreated += 1;
      }
    }

    const workingSetPatchSummary = this.applyConversationWorkingSetBackfill();
    changes.conversationsPatched += workingSetPatchSummary.conversationsPatched;
    changes.episodesCreated += workingSetPatchSummary.episodesCreated;

    return {
      countsBefore: originalCounts,
      countsAfter: {
        persons: this.persons.length,
        projects: this.projects.length,
        tasks: this.tasks.length,
        executions: this.executions.length,
        episodes: this.episodes.length
      },
      changes
    };
  }

  applyConversationWorkingSetBackfill() {
    let conversationsPatched = 0;
    let episodesCreated = 0;

    for (const conversation of this.conversations) {
      const person = this.ensurePersonForConversation(conversation);
      const normalizedMemory = normalizeSupervisorTaskMemory(conversation?.metadata?.supervisor?.taskMemory || null);
      const trackedSupervisorTasks = listSupervisorTaskRecords(normalizedMemory);

      const assistantTaskIds = trackedSupervisorTasks
        .map((entry) => {
          const supervisorTask = this.supervisorTasks.find((task) => toText(task?.id) === toText(entry?.taskId));
          return toText(supervisorTask?.metadata?.assistantTaskId);
        })
        .filter(Boolean);

      const primarySupervisorTaskId = toText(
        normalizedMemory?.activeTaskId
        || conversation?.activeTaskId
      );
      const primarySupervisorTask = this.supervisorTasks.find((task) => toText(task?.id) === primarySupervisorTaskId) || null;
      const primaryTaskId = toText(
        primarySupervisorTask?.metadata?.assistantTaskId
        || assistantTaskIds[0]
      );
      const primaryTask = this.tasks.find((entry) => toText(entry?.id) === primaryTaskId) || null;
      const primaryProjectId = toText(
        primaryTask?.projectId
        || primarySupervisorTask?.metadata?.assistantProjectId
      );

      const recentMessages = normalizeRecentMessages(
        conversation?.metadata?.assistantDomain?.recentMessages
        || [],
        20
      );
      const workingSet = normalizeConversationWorkingSet({
        primaryProjectId,
        primaryTaskId,
        recentTaskIds: assistantTaskIds,
        mentionedProjectIds: primaryProjectId ? [primaryProjectId] : []
      });

      const nextConversation = {
        ...conversation,
        metadata: {
          ...(conversation.metadata || {}),
          assistantDomain: {
            ...(conversation.metadata?.assistantDomain || {}),
            personId: person.id,
            workingSet,
            recentMessages
          }
        }
      };
      this._replaceLegacyRecord(this.conversations, nextConversation);
      this.conversationById.set(toText(nextConversation.id), nextConversation);
      conversationsPatched += 1;

      const createdEpisode = this.appendEpisodeOnce({
        kind: 'migration.backfilled_conversation_working_set',
        personId: person.id,
        projectId: primaryProjectId,
        taskId: primaryTaskId,
        conversationId: toText(conversation?.id),
        payload: {
          primaryProjectId,
          primaryTaskId,
          recentTaskCount: workingSet.recentTaskIds.length
        },
        metadata: {
          migrationKey: `conversation-working-set:${toText(conversation?.id)}`
        }
      });
      if (createdEpisode) {
        episodesCreated += 1;
      }
    }

    return {
      conversationsPatched,
      episodesCreated
    };
  }

  applyApprovalPolicyScopeMigration() {
    let migratedPolicies = 0;
    let unresolvedPolicies = 0;

    const updatedPolicies = this.approvalPolicies.map((policy) => {
      const originalScope = toText(policy?.scope);
      const canonicalScope = normalizeScope(originalScope);
      const originalScopeRef = toText(policy?.scopeRef);
      let nextScopeRef = originalScopeRef;

      if (canonicalScope === 'execution') {
        const execution = this.executions.find((entry) => (
          toText(entry?.currentRuntimeSessionId) === originalScopeRef
          || (Array.isArray(entry?.runtimeSessionHistory) && entry.runtimeSessionHistory.includes(originalScopeRef))
          || toText(entry?.id) === originalScopeRef
        ));
        nextScopeRef = toText(execution?.id || originalScopeRef);
      } else if (canonicalScope === 'task') {
        const conversation = this.conversations.find((entry) => toText(entry?.id) === originalScopeRef);
        nextScopeRef = toText(
          conversation?.metadata?.assistantDomain?.workingSet?.primaryTaskId
          || originalScopeRef
        );
      } else if (canonicalScope === 'project') {
        const normalizedRef = normalizeWorkspaceRef(originalScopeRef);
        const project = this.projects.find((entry) => (
          toText(entry?.id) === originalScopeRef
          || normalizeWorkspaceRef(entry?.cwd) === normalizedRef
        ));
        nextScopeRef = toText(project?.id || originalScopeRef);
      } else if (canonicalScope === 'person') {
        const matchedPerson = this.persons.find((entry) => (
          toText(entry?.id) === originalScopeRef
          || toText(entry?.metadata?.globalUserId) === originalScopeRef
        ));
        nextScopeRef = toText(matchedPerson?.id || originalScopeRef || 'default-user');
      }

      const changed = originalScope !== canonicalScope || originalScopeRef !== nextScopeRef;
      let unresolved = false;
      if (!nextScopeRef) {
        unresolved = true;
      } else if (canonicalScope === 'execution' && nextScopeRef === originalScopeRef) {
        unresolved = !this.executions.some((entry) => toText(entry?.id) === nextScopeRef);
      } else if (canonicalScope === 'task' && nextScopeRef === originalScopeRef) {
        unresolved = !this.tasks.some((entry) => toText(entry?.id) === nextScopeRef);
      } else if (canonicalScope === 'project' && nextScopeRef === originalScopeRef) {
        unresolved = !this.projects.some((entry) => toText(entry?.id) === nextScopeRef);
      } else if (canonicalScope === 'person' && nextScopeRef === originalScopeRef) {
        unresolved = !this.persons.some((entry) => toText(entry?.id) === nextScopeRef);
      }

      if (changed) {
        migratedPolicies += 1;
      }
      if (unresolved) {
        unresolvedPolicies += 1;
      }

      return {
        ...policy,
        scope: canonicalScope || originalScope,
        scopeRef: nextScopeRef || originalScopeRef,
        metadata: mergeMetadata(policy.metadata, {
          originalScope,
          originalScopeRef,
          migratedAt: nowIso()
        })
      };
    });

    this.approvalPolicies = updatedPolicies;
    return {
      migratedPolicies,
      unresolvedPolicies
    };
  }

  exportState() {
    return {
      persons: dedupeById(this.persons),
      projects: dedupeById(this.projects),
      tasks: dedupeById(this.tasks),
      executions: dedupeById(this.executions),
      episodes: dedupeById(this.episodes),
      supervisorTasks: dedupeById(this.supervisorTasks),
      conversations: dedupeById(this.conversations),
      runtimeSessions: dedupeById(this.runtimeSessions),
      approvalPolicies: dedupeById(this.approvalPolicies)
    };
  }

  _replaceRecord(list, record) {
    const id = toText(record?.id);
    const index = list.findIndex((entry) => toText(entry?.id) === id);
    if (index >= 0) {
      list[index] = record;
    } else {
      list.push(record);
    }
  }

  _replaceLegacyRecord(list, record) {
    const id = toText(record?.id);
    const index = list.findIndex((entry) => toText(entry?.id) === id);
    if (index >= 0) {
      list[index] = record;
    } else {
      list.push(record);
    }
  }
}
