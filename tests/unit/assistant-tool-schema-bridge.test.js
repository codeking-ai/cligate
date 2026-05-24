import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';

import createDefaultAssistantToolRegistry from '../../src/assistant-core/tool-registry.js';
import { createBuiltinAssistantToolRegistry } from '../../src/assistant-tools/index.js';
import { buildAnthropicToolDefinitions } from '../../src/assistant-agent/tool-schema.js';

test('assistant agent tool-schema keeps legacy assistant-core schemas', () => {
  const registry = createDefaultAssistantToolRegistry({
    observationService: {
      getWorkspaceContext() { return {}; },
      listRuntimeSessions() { return []; },
      getRuntimeSessionDetail() { return {}; },
      listConversations() { return []; },
      getConversationContext() { return {}; }
    },
    messageService: {
      startRuntimeTask() { return {}; },
      continueRuntimeTask() { return {}; },
      createExecutionHandoff() { return {}; },
      consumeExecutionHandoff() { return {}; }
    },
    taskViewService: {
      getConversationTaskSpace() { return {}; },
      getTask() { return null; },
      listTasks() { return []; }
    },
    clarificationStore: {
      create() { return {}; }
    },
    workspaceStore: {
      list() { return []; },
      getByRef() { return null; },
      upsert() { return {}; }
    }
  });

  const tools = buildAnthropicToolDefinitions(registry);
  const continueTask = tools.find((tool) => tool.name === 'continue_task');

  assert.equal(continueTask?.input_schema?.type, 'object');
  assert.equal(continueTask?.input_schema?.properties?.message?.type, 'string');
  assert.deepEqual(continueTask?.input_schema?.required, ['message']);
});

test('assistant agent tool-schema uses registry-provided inputSchema for assistant-tools registries', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'assistant-tool-schema-bridge-'));
  const { registry } = createBuiltinAssistantToolRegistry({ workspaceRoot });

  const tools = buildAnthropicToolDefinitions(registry);
  const viewImage = tools.find((tool) => tool.name === 'view_image');
  const callMcpTool = tools.find((tool) => tool.name === 'call_mcp_tool');

  assert.equal(viewImage?.input_schema?.type, 'object');
  assert.equal(viewImage?.input_schema?.properties?.detail?.type, 'string');
  assert.deepEqual(viewImage?.input_schema?.properties?.detail?.enum, ['low', 'high', 'original']);
  assert.equal(callMcpTool?.input_schema?.properties?.namespacedToolName?.type, 'string');
});
