import { createArtifact, nowIso, toText } from './models.js';
import { JsonEntityStore } from './store-utils.js';

export class ArtifactStore extends JsonEntityStore {
  constructor(options = {}) {
    super({
      ...options,
      fileName: 'artifacts.json',
      rootKey: 'artifacts'
    });
  }

  create(payload = {}) {
    return this.save(createArtifact(payload));
  }

  save(artifact = {}) {
    const normalized = createArtifact({
      ...artifact,
      id: artifact.id,
      createdAt: artifact.createdAt,
      updatedAt: nowIso()
    });
    return super.save(normalized);
  }

  listByConversation(conversationId, { limit = 50 } = {}) {
    const normalizedConversationId = toText(conversationId);
    return this.list({
      limit,
      predicate: (entry) => entry.conversationId === normalizedConversationId
    });
  }

  listByTask(taskId, { limit = 50 } = {}) {
    const normalizedTaskId = toText(taskId);
    return this.list({
      limit,
      predicate: (entry) => entry.taskId === normalizedTaskId
    });
  }

  listByProject(projectId, { limit = 50 } = {}) {
    const normalizedProjectId = toText(projectId);
    return this.list({
      limit,
      predicate: (entry) => entry.projectId === normalizedProjectId
    });
  }
}

export const artifactStore = new ArtifactStore();

export default artifactStore;
