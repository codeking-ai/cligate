import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';

import { createBuiltinAssistantToolRegistry } from '../../src/assistant-tools/index.js';
import {
  listAssistantToolDefinitions,
  buildAssistantAnthropicToolDefinitions,
  buildAssistantOpenAIResponsesToolDefinitions,
  buildAssistantOpenAIChatToolDefinitions,
  buildAssistantGeminiToolDefinitions
} from '../../src/translators/tools/index.js';

test('assistant-tools translator lists tools with filtering by approval, visibility, source, and name', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'assistant-tools-export-'));
  const { registry } = createBuiltinAssistantToolRegistry({ workspaceRoot });

  const nonApprovalTools = listAssistantToolDefinitions(registry, {
    includeApprovalRequired: false
  });
  assert.ok(nonApprovalTools.some((tool) => tool.name === 'read_file'));
  assert.equal(nonApprovalTools.some((tool) => tool.name === 'write_file'), false);

  const mcpTools = listAssistantToolDefinitions(registry, {
    includeApprovalRequired: true,
    sources: ['mcp']
  });
  assert.ok(mcpTools.every((tool) => tool.source === 'mcp'));
  assert.ok(mcpTools.some((tool) => tool.name === 'list_mcp_servers'));

  const byName = listAssistantToolDefinitions(registry, {
    includeApprovalRequired: true,
    names: ['view_image']
  });
  assert.deepEqual(byName.map((tool) => tool.name), ['view_image']);
});

test('assistant-tools translator exports Anthropic tool definitions with sanitized schemas', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'assistant-tools-anthropic-'));
  const { registry } = createBuiltinAssistantToolRegistry({ workspaceRoot });

  const tools = buildAssistantAnthropicToolDefinitions(registry, {
    names: ['read_file', 'view_image'],
    includeApprovalRequired: true
  });

  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, 'read_file');
  assert.equal(tools[0].input_schema.type, 'object');
  assert.equal(tools[1].name, 'view_image');
  assert.equal(tools[1].input_schema.properties.detail.type, 'string');
});

test('assistant-tools translator exports OpenAI Responses and Chat tool definitions', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'assistant-tools-openai-'));
  const { registry } = createBuiltinAssistantToolRegistry({ workspaceRoot });

  const responsesTools = buildAssistantOpenAIResponsesToolDefinitions(registry, {
    names: ['read_file', 'grep_search'],
    includeApprovalRequired: true
  });
  assert.equal(responsesTools.length, 2);
  assert.equal(responsesTools[0].type, 'function');
  assert.equal(responsesTools[0].name, 'read_file');
  assert.equal(responsesTools[0].parameters.type, 'object');

  const chatTools = buildAssistantOpenAIChatToolDefinitions(registry, {
    names: ['read_file'],
    includeApprovalRequired: true
  });
  assert.equal(chatTools.length, 1);
  assert.equal(chatTools[0].type, 'function');
  assert.equal(chatTools[0].function.name, 'read_file');
  assert.equal(chatTools[0].function.parameters.type, 'object');
});

test('assistant-tools translator exports Gemini functionDeclarations groups', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'assistant-tools-gemini-'));
  const { registry } = createBuiltinAssistantToolRegistry({ workspaceRoot });

  const groups = buildAssistantGeminiToolDefinitions(registry, {
    names: ['list_directory', 'stat_path'],
    includeApprovalRequired: true
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].functionDeclarations.length, 2);
  assert.equal(groups[0].functionDeclarations[0].name, 'list_directory');
  assert.equal(groups[0].functionDeclarations[0].parameters.type, 'object');
});
