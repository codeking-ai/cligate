import artifactStoreSingleton, { ArtifactStore } from './domain/artifact-store.js';
import assistantDomainTaskStore from './domain/task-store.js';
import assistantDomainExecutionStore from './domain/execution-store.js';
import assistantDomainProjectStore from './domain/project-store.js';
import { normalizeTaskWorkingMemory, nowIso } from './domain/models.js';

function toText(value) {
  return String(value || '').trim();
}

function truncate(value, limit = 240) {
  const text = toText(value);
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function inferImageSummary({ title = '', path = '', role = '', source = '' } = {}) {
  const label = toText(title) || toText(path) || 'image';
  return truncate(`${role || 'assistant'} ${source || 'artifact'}: ${label}`, 160);
}

function toRelevantArtifactSummary(entry = {}) {
  return {
    id: toText(entry.id),
    kind: toText(entry.kind),
    source: toText(entry.source),
    role: toText(entry.role),
    title: toText(entry.title),
    summary: toText(entry.summary),
    mediaType: toText(entry.mediaType),
    path: toText(entry.path),
    imageUrl: toText(entry.imageUrl),
    contentText: truncate(entry.contentText, 240),
    conversationId: toText(entry.conversationId),
    taskId: toText(entry.taskId),
    projectId: toText(entry.projectId),
    assistantRunId: toText(entry.assistantRunId),
    updatedAt: toText(entry.updatedAt || entry.createdAt)
  };
}

function artifactScore(entry = {}, {
  preferredTaskId = '',
  preferredProjectId = '',
  conversationId = ''
} = {}) {
  let score = 0;
  if (preferredTaskId && entry.taskId === preferredTaskId) score += 100;
  if (preferredProjectId && entry.projectId === preferredProjectId) score += 40;
  if (conversationId && entry.conversationId === conversationId) score += 20;
  if (entry.kind === 'image') score += 10;
  if (entry.source === 'view_image') score += 5;
  return score;
}

export class ArtifactService {
  constructor({
    artifactStore = artifactStoreSingleton,
    taskStore = assistantDomainTaskStore,
    executionStore = assistantDomainExecutionStore,
    projectStore = assistantDomainProjectStore
  } = {}) {
    this.artifactStore = artifactStore instanceof ArtifactStore ? artifactStore : artifactStore;
    this.taskStore = taskStore;
    this.executionStore = executionStore;
    this.projectStore = projectStore;
  }

  createArtifact(payload = {}) {
    const artifact = this.artifactStore.create({
      ...payload,
      summary: toText(payload.summary)
        || (toText(payload.kind).includes('image')
          ? inferImageSummary(payload)
          : truncate(payload.contentText || payload.title || payload.path, 160)),
      updatedAt: nowIso()
    });
    const taskId = toText(artifact.taskId);
    if (taskId) {
      this.attachArtifactToTask(taskId, artifact.id);
    }
    return artifact;
  }

  attachArtifactToTask(taskId = '', artifactId = '') {
    const current = this.taskStore?.get?.(taskId);
    if (!current?.id || !artifactId) return current;
    const workingMemory = normalizeTaskWorkingMemory(current.workingMemory);
    const nextArtifactRefs = [...new Set([...(workingMemory.artifactRefs || []), artifactId])].slice(-20);
    return this.taskStore.save({
      ...current,
      workingMemory: {
        ...workingMemory,
        artifactRefs: nextArtifactRefs,
        lastUpdatedAt: nowIso()
      }
    });
  }

  listRelevantArtifacts({
    conversationId = '',
    taskId = '',
    projectId = '',
    limit = 8
  } = {}) {
    const seen = new Set();
    const result = [];
    const push = (entry) => {
      if (!entry?.id || seen.has(entry.id)) return;
      seen.add(entry.id);
      result.push(toRelevantArtifactSummary(entry));
    };

    const normalizedTaskId = toText(taskId);
    if (normalizedTaskId) {
      const task = this.taskStore?.get?.(normalizedTaskId) || null;
      const refs = Array.isArray(task?.workingMemory?.artifactRefs) ? task.workingMemory.artifactRefs : [];
      for (const artifactId of refs) {
        const artifact = this.artifactStore.get(artifactId);
        if (artifact) push(artifact);
      }
      for (const artifact of this.artifactStore.listByTask(normalizedTaskId, { limit })) {
        push(artifact);
      }
    }

    const normalizedConversationId = toText(conversationId);
    if (normalizedConversationId) {
      for (const artifact of this.artifactStore.listByConversation(normalizedConversationId, { limit })) {
        push(artifact);
      }
    }

    const normalizedProjectId = toText(projectId);
    if (normalizedProjectId) {
      for (const artifact of this.artifactStore.listByProject(normalizedProjectId, { limit })) {
        push(artifact);
      }
    }

    return result
      .sort((left, right) => {
        const scoreDiff = artifactScore(right, {
          preferredTaskId: normalizedTaskId,
          preferredProjectId: normalizedProjectId,
          conversationId: normalizedConversationId
        }) - artifactScore(left, {
          preferredTaskId: normalizedTaskId,
          preferredProjectId: normalizedProjectId,
          conversationId: normalizedConversationId
        });
        if (scoreDiff !== 0) return scoreDiff;
        return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
      })
      .slice(0, Math.max(1, limit));
  }

  getArtifact(id = '') {
    return this.artifactStore.get(id);
  }
}

export const artifactService = new ArtifactService();

export default artifactService;
