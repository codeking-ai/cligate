import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ArtifactStore } from '../../src/assistant-core/domain/artifact-store.js';
import { TaskStore } from '../../src/assistant-core/domain/task-store.js';
import { ExecutionStore } from '../../src/assistant-core/domain/execution-store.js';
import { ProjectStore } from '../../src/assistant-core/domain/project-store.js';
import { ArtifactService } from '../../src/assistant-core/artifact-service.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('ArtifactService creates durable artifacts and attaches refs to task workingMemory', () => {
  const configDir = createTempDir('cligate-artifact-service-');
  const artifactStore = new ArtifactStore({ configDir });
  const taskStore = new TaskStore({ configDir });
  const executionStore = new ExecutionStore({ configDir });
  const projectStore = new ProjectStore({ configDir });
  const service = new ArtifactService({
    artifactStore,
    taskStore,
    executionStore,
    projectStore
  });

  const task = taskStore.create({
    id: 'task-artifact-1',
    projectId: 'project-artifact-1',
    ownerPersonId: 'person-artifact-1',
    title: 'artifact task'
  });

  const artifact = service.createArtifact({
    kind: 'image',
    source: 'chat_ui_upload',
    conversationId: 'conversation-artifact-1',
    taskId: task.id,
    role: 'user',
    title: 'uploaded image',
    mediaType: 'image/png',
    imageUrl: 'data:image/png;base64,abc'
  });

  assert.ok(artifact.id);
  const updatedTask = taskStore.get(task.id);
  assert.ok(Array.isArray(updatedTask?.workingMemory?.artifactRefs));
  assert.ok(updatedTask.workingMemory.artifactRefs.includes(artifact.id));

  const relevant = service.listRelevantArtifacts({
    conversationId: 'conversation-artifact-1',
    taskId: task.id,
    limit: 5
  });
  assert.equal(relevant.length, 1);
  assert.equal(relevant[0].id, artifact.id);
  assert.equal(relevant[0].mediaType, 'image/png');
});

test('ArtifactService ranks task-bound artifacts ahead of broader conversation/project artifacts', () => {
  const configDir = createTempDir('cligate-artifact-ranking-');
  const artifactStore = new ArtifactStore({ configDir });
  const taskStore = new TaskStore({ configDir });
  const executionStore = new ExecutionStore({ configDir });
  const projectStore = new ProjectStore({ configDir });
  const service = new ArtifactService({
    artifactStore,
    taskStore,
    executionStore,
    projectStore
  });

  taskStore.create({
    id: 'task-rank-1',
    projectId: 'project-rank-1',
    ownerPersonId: 'person-rank-1',
    title: 'rank task',
    workingMemory: {
      artifactRefs: ['artifact-task-priority']
    }
  });

  artifactStore.create({
    id: 'artifact-conversation-fallback',
    kind: 'image',
    source: 'chat_ui_upload',
    conversationId: 'conversation-rank-1',
    projectId: 'project-rank-1',
    title: 'conversation artifact',
    imageUrl: 'data:image/png;base64,conv'
  });
  artifactStore.create({
    id: 'artifact-task-priority',
    kind: 'image',
    source: 'view_image',
    conversationId: 'conversation-rank-1',
    projectId: 'project-rank-1',
    taskId: 'task-rank-1',
    title: 'task artifact',
    imageUrl: 'data:image/png;base64,task'
  });

  const relevant = service.listRelevantArtifacts({
    conversationId: 'conversation-rank-1',
    taskId: 'task-rank-1',
    projectId: 'project-rank-1',
    limit: 5
  });

  assert.equal(relevant[0].id, 'artifact-task-priority');
});
