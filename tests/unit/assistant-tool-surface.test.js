import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssistantToolRegistry } from '../../src/assistant-core/tool-registry.js';
import { AssistantToolExecutor } from '../../src/assistant-core/tool-executor.js';
import { AssistantToolsRegistry } from '../../src/assistant-tools/index.js';
import { normalizeAssistantToolResultEntry, isToolResultConfirmationRequired } from '../../src/assistant-agent/tool-result.js';
import {
  createOptionalAssistantExecutionSurface
} from '../../src/assistant-agent/tool-surface.js';

test('assistant tool-result normalizer understands native assistant-tools policy blocks', () => {
  const normalized = normalizeAssistantToolResultEntry({
    toolName: 'write_file',
    input: { path: 'a.txt' },
    status: 'requires_approval',
    content: [{
      type: 'text',
      text: 'Tool call requires approval: mutating_tool_requires_confirmation'
    }],
    structured: {
      kind: 'policy_block',
      reason: 'mutating_tool_requires_confirmation',
      requiresApproval: true
    },
    metadata: {
      policy: { allowed: true, requiresApproval: true }
    }
  });

  assert.equal(normalized.success, false);
  assert.equal(normalized.payload.kind, 'policy_block');
  assert.equal(isToolResultConfirmationRequired({
    toolName: 'write_file',
    input: { path: 'a.txt' },
    status: 'requires_approval',
    structured: normalized.payload
  }), true);
  assert.match(String(normalized.summary || ''), /requires approval/i);
});

test('assistant tool-surface composes supervisor and execution registries and dispatches to the correct executor', async () => {
  const primaryRegistry = new AssistantToolRegistry();
  primaryRegistry.register({
    name: 'list_tasks',
    description: 'List tasks',
    execute: async () => []
  });

  const secondaryRegistry = new AssistantToolsRegistry();
  secondaryRegistry.register({
    name: 'read_file',
    description: 'Read file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' }
      }
    },
    execute: async () => ({
      path: 'README.md',
      text: 'hello'
    })
  });

  const primaryExecutor = new AssistantToolExecutor({
    toolRegistry: primaryRegistry,
    policyService: {
      canExecuteToolCall() {
        return { allowed: true };
      }
    }
  });

  const surface = createOptionalAssistantExecutionSurface({
    primaryRegistry,
    primaryExecutor,
    secondaryRegistry,
    secondaryExecutor: {
      async executeToolCall() {
        return {
          status: 'completed',
          content: [{ type: 'text', text: 'Tool read_file completed' }],
          structured: {
            path: 'README.md',
            text: 'hello'
          },
          metadata: {
            policy: { allowed: true }
          }
        };
      }
    }
  });

  const listed = surface.toolRegistry.list();
  assert.ok(listed.some((tool) => tool.name === 'list_tasks'));
  assert.ok(listed.some((tool) => tool.name === 'read_file'));

  const result = await surface.toolExecutor.executeToolCall({
    toolName: 'read_file',
    input: { path: 'README.md' }
  }, {});

  assert.equal(result.status, 'completed');
  assert.equal(result.toolName, 'read_file');
  assert.equal(result.structured.path, 'README.md');
  assert.equal(result.structured.text, 'hello');
});
