function toText(value) {
  return String(value || '').trim();
}

function buildSet(values = []) {
  return new Set((Array.isArray(values) ? values : []).map((entry) => toText(entry)).filter(Boolean));
}

export function verifyAssistantDomainConsistency(state) {
  const issues = [];

  const taskById = new Map(
    state.assistantDomain.tasks
      .map((entry) => [toText(entry?.id), entry])
      .filter(([id]) => id)
  );
  const projectById = new Map(
    state.assistantDomain.projects
      .map((entry) => [toText(entry?.id), entry])
      .filter(([id]) => id)
  );
  const executionById = new Map(
    state.assistantDomain.executions
      .map((entry) => [toText(entry?.id), entry])
      .filter(([id]) => id)
  );

  for (const task of state.assistantDomain.tasks) {
    const taskId = toText(task?.id);
    const projectId = toText(task?.projectId);
    const project = projectById.get(projectId);
    if (!project) {
      issues.push(`task ${taskId} references missing project ${projectId}`);
      continue;
    }

    const isTerminal = ['completed', 'failed', 'cancelled'].includes(toText(task?.lifecycleState));
    const activeTaskIds = buildSet(project.activeTaskIds);
    const archivedTaskIds = buildSet(project.archivedTaskIds);
    if (isTerminal && !archivedTaskIds.has(taskId)) {
      issues.push(`terminal task ${taskId} missing from project ${projectId} archivedTaskIds`);
    }
    if (!isTerminal && !activeTaskIds.has(taskId)) {
      issues.push(`open task ${taskId} missing from project ${projectId} activeTaskIds`);
    }

    const allExecutionIds = buildSet(task.allExecutionIds);
    const activeExecutionIds = buildSet(task.activeExecutionIds);
    for (const executionId of allExecutionIds) {
      const execution = executionById.get(executionId);
      if (!execution) {
        issues.push(`task ${taskId} references missing execution ${executionId}`);
        continue;
      }
      if (toText(execution?.taskId) !== taskId) {
        issues.push(`execution ${executionId} points to task ${toText(execution?.taskId)} instead of ${taskId}`);
      }
    }

    for (const executionId of activeExecutionIds) {
      const execution = executionById.get(executionId);
      if (!execution) {
        issues.push(`task ${taskId} activeExecutionIds contains missing execution ${executionId}`);
        continue;
      }
      const executionStatus = toText(execution?.status);
      const activeStatuses = new Set(['spawning', 'ready', 'running', 'waiting_approval', 'waiting_user']);
      if (!activeStatuses.has(executionStatus)) {
        issues.push(`task ${taskId} marks execution ${executionId} active but status is ${executionStatus}`);
      }
    }
  }

  for (const conversation of state.conversations) {
    const conversationId = toText(conversation?.id);
    const assistantDomain = conversation?.metadata?.assistantDomain && typeof conversation.metadata.assistantDomain === 'object'
      ? conversation.metadata.assistantDomain
      : null;
    if (!assistantDomain) {
      issues.push(`conversation ${conversationId} missing metadata.assistantDomain`);
      continue;
    }

    const primaryTaskId = toText(assistantDomain?.workingSet?.primaryTaskId);
    const primaryProjectId = toText(assistantDomain?.workingSet?.primaryProjectId);

    if (primaryTaskId) {
      const task = taskById.get(primaryTaskId);
      if (!task) {
        issues.push(`conversation ${conversationId} workingSet.primaryTaskId ${primaryTaskId} is missing`);
      } else if (primaryProjectId && toText(task?.projectId) !== primaryProjectId) {
        issues.push(`conversation ${conversationId} primaryTaskId ${primaryTaskId} does not belong to primaryProjectId ${primaryProjectId}`);
      }
    }

    if (primaryProjectId && !projectById.has(primaryProjectId)) {
      issues.push(`conversation ${conversationId} workingSet.primaryProjectId ${primaryProjectId} is missing`);
    }
  }

  return issues;
}

export function reconcileAssistantDomainLinks(state) {
  const assistantTaskIds = new Set(
    state.assistantDomain.tasks.map((entry) => toText(entry?.id)).filter(Boolean)
  );
  const assistantExecutionIds = new Set(
    state.assistantDomain.executions.map((entry) => toText(entry?.id)).filter(Boolean)
  );
  const assistantPersonIds = new Set(
    state.assistantDomain.persons.map((entry) => toText(entry?.id)).filter(Boolean)
  );

  const missingTaskLinks = [];
  const missingExecutionLinks = [];
  const missingPersonLinks = [];

  for (const task of state.supervisorTasks) {
    const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : {};
    const assistantTaskId = toText(metadata.assistantTaskId);
    const assistantExecutionId = toText(metadata.assistantExecutionId);
    const assistantPersonId = toText(metadata.assistantPersonId);

    if (!assistantTaskId || !assistantTaskIds.has(assistantTaskId)) {
      missingTaskLinks.push({
        supervisorTaskId: toText(task?.id),
        assistantTaskId
      });
    }
    if (!assistantExecutionId || !assistantExecutionIds.has(assistantExecutionId)) {
      missingExecutionLinks.push({
        supervisorTaskId: toText(task?.id),
        assistantExecutionId
      });
    }
    if (!assistantPersonId || !assistantPersonIds.has(assistantPersonId)) {
      missingPersonLinks.push({
        supervisorTaskId: toText(task?.id),
        assistantPersonId
      });
    }
  }

  return {
    missingTaskLinks,
    missingExecutionLinks,
    missingPersonLinks
  };
}
