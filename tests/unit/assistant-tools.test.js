import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';

import {
  AssistantToolsRegistry,
  WorkspaceGuard,
  AssistantToolPolicyService,
  AssistantToolsExecutor,
  AssistantMcpService,
  runAssistantToolLoop,
  createBuiltinAssistantToolRegistry,
  buildNamespacedMcpToolName,
  parseNamespacedMcpToolName
} from '../../src/assistant-tools/index.js';

test('AssistantToolsRegistry registers tools and filters by visibility', () => {
  const registry = new AssistantToolsRegistry();
  registry.register({
    name: 'read_file',
    visibility: 'direct',
    execute: async () => ({ ok: true })
  });
  registry.register({
    name: 'internal_tool',
    visibility: 'hidden',
    execute: async () => ({ ok: true })
  });

  assert.equal(registry.get('read_file')?.name, 'read_file');
  assert.equal(registry.list({ visibility: 'direct' }).length, 1);
  assert.equal(registry.list({ visibility: 'hidden' }).length, 1);
});

test('WorkspaceGuard resolves relative paths and blocks workspace escape', () => {
  const guard = new WorkspaceGuard({ workspaceRoot: path.resolve('D:/tmp/workspace-root') });
  const inside = guard.resolvePath('src/index.js');

  assert.match(inside, /workspace-root/i);
  assert.throws(() => guard.resolvePath('../outside.txt'), /outside the workspace/i);
});

test('AssistantToolPolicyService denies outside-workspace paths and requires approval for mutating tools', () => {
  const workspaceRoot = path.resolve('D:/tmp/policy-workspace');
  const workspaceGuard = new WorkspaceGuard({ workspaceRoot });
  const policy = new AssistantToolPolicyService({
    workspaceGuard,
    allowMutatingTools: true
  });

  const readDecision = policy.evaluateToolCall({
    tool: { name: 'read_file', mutating: false },
    invocation: { input: { path: 'notes.txt' } },
    context: { cwd: workspaceRoot }
  });
  assert.equal(readDecision.allowed, true);
  assert.equal(readDecision.requiresApproval, false);
  assert.equal(readDecision.grantedPermissions.read.length, 1);

  const mutatingDecision = policy.evaluateToolCall({
    tool: { name: 'edit_file', mutating: true },
    invocation: { input: { path: 'notes.txt' } },
    context: { cwd: workspaceRoot }
  });
  assert.equal(mutatingDecision.allowed, true);
  assert.equal(mutatingDecision.requiresApproval, true);

  // Read-only path outside the workspace, no approval signal: hard deny.
  // This restores the pre-fix behavior — we briefly tried routing reads
  // through the requires_approval flow but that left the assistant stuck
  // mid-task after the confirmation roundtrip resolved.
  const deniedDecision = policy.evaluateToolCall({
    tool: { name: 'read_file', mutating: false },
    invocation: { input: { path: '../outside.txt' } },
    context: { cwd: workspaceRoot }
  });
  assert.equal(deniedDecision.allowed, false);
  assert.equal(deniedDecision.reason, 'path_outside_workspace');

  // ...but when the conversation has been opted into autoApproveAll (or the
  // call explicitly carries metadata.approved=true), the SAME read passes
  // immediately without a confirmation prompt — the fix for the original
  // complaint that "我直接同意" had no effect on read paths.
  const approvedOutsideReadDecision = policy.evaluateToolCall({
    tool: { name: 'read_file', mutating: false },
    invocation: { input: { path: '../outside.txt' }, metadata: { approved: true } },
    context: { cwd: workspaceRoot }
  });
  assert.equal(approvedOutsideReadDecision.allowed, true);
  assert.equal(approvedOutsideReadDecision.requiresApproval, false);

  const autoApproveOutsideReadDecision = policy.evaluateToolCall({
    tool: { name: 'read_file', mutating: false },
    invocation: { input: { path: '../outside.txt' } },
    context: { cwd: workspaceRoot, autoApproveAll: true }
  });
  assert.equal(autoApproveOutsideReadDecision.allowed, true);
  assert.equal(autoApproveOutsideReadDecision.requiresApproval, false);

  // desktop_* tools operate on OS paths (e.g. installer EXEs in Downloads)
  // and should never be gated by the workspace root.
  const desktopOutsideDecision = policy.evaluateToolCall({
    tool: { name: 'desktop_launch_app', mutating: false },
    invocation: { input: { path: 'C:/Users/test/Downloads/installer.exe' } },
    context: { cwd: workspaceRoot }
  });
  assert.equal(desktopOutsideDecision.allowed, true);
  assert.equal(desktopOutsideDecision.requiresApproval, false);

  const outsideMutatingDecision = policy.evaluateToolCall({
    tool: { name: 'write_file', mutating: true, requiresApproval: true },
    invocation: { input: { path: '../outside.txt', content: 'hello' } },
    context: { cwd: workspaceRoot }
  });
  assert.equal(outsideMutatingDecision.allowed, true);
  assert.equal(outsideMutatingDecision.requiresApproval, true);
  assert.equal(outsideMutatingDecision.reason, 'path_outside_workspace_requires_confirmation');
  assert.equal(outsideMutatingDecision.requestedPath, '../outside.txt');
});

test('AssistantToolsExecutor executes built-in file tools inside the workspace', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'assistant-tools-'));
  await mkdir(path.join(workspaceRoot, 'src'));
  await writeFile(path.join(workspaceRoot, 'src', 'example.js'), 'line 1\nline 2\nline 3\n', 'utf8');

  const { registry, workspaceGuard } = createBuiltinAssistantToolRegistry({ workspaceRoot });
  const executor = new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: new AssistantToolPolicyService({ workspaceGuard })
  });

  const readResult = await executor.executeToolCall({
    toolName: 'read_file',
    input: {
      path: 'src/example.js',
      startLine: 2,
      endLine: 3
    }
  }, {
    cwd: workspaceRoot
  });

  assert.equal(readResult.status, 'completed');
  assert.equal(readResult.structured.path, path.join('src', 'example.js'));
  assert.match(readResult.structured.text, /line 2/);
  assert.doesNotMatch(readResult.structured.text, /line 1/);

  const statResult = await executor.executeToolCall({
    toolName: 'stat_path',
    input: { path: 'src/example.js' }
  }, {
    cwd: workspaceRoot
  });

  assert.equal(statResult.status, 'completed');
  assert.equal(statResult.structured.type, 'file');
});

test('AssistantToolsExecutor supports glob and grep search tools', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'assistant-tools-search-'));
  await mkdir(path.join(workspaceRoot, 'src', 'nested'), { recursive: true });
  await writeFile(path.join(workspaceRoot, 'src', 'alpha.js'), 'const alpha = 1;\n', 'utf8');
  await writeFile(path.join(workspaceRoot, 'src', 'nested', 'beta.js'), 'const beta = 2;\nconst target = true;\n', 'utf8');

  const { registry, workspaceGuard } = createBuiltinAssistantToolRegistry({ workspaceRoot });
  const executor = new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: new AssistantToolPolicyService({ workspaceGuard })
  });

  const globResult = await executor.executeToolCall({
    toolName: 'glob_search',
    input: {
      pattern: 'src/**/*.js'
    }
  }, {
    cwd: workspaceRoot
  });

  assert.equal(globResult.status, 'completed');
  assert.equal(globResult.structured.matches.length, 2);

  const grepResult = await executor.executeToolCall({
    toolName: 'grep_search',
    input: {
      path: 'src',
      pattern: 'target'
    }
  }, {
    cwd: workspaceRoot
  });

  assert.equal(grepResult.status, 'completed');
  assert.equal(grepResult.structured.matches.length, 1);
  assert.equal(grepResult.structured.matches[0].path, path.join('src', 'nested', 'beta.js'));
});

test('AssistantToolsExecutor mutating tools require approval and then update files', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'assistant-tools-mutate-'));
  await mkdir(path.join(workspaceRoot, 'notes'), { recursive: true });
  await writeFile(path.join(workspaceRoot, 'notes', 'todo.txt'), 'hello world\n', 'utf8');

  const { registry, workspaceGuard } = createBuiltinAssistantToolRegistry({ workspaceRoot });
  const executor = new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: new AssistantToolPolicyService({
      workspaceGuard,
      allowMutatingTools: true
    })
  });

  const approvalResult = await executor.executeToolCall({
    toolName: 'write_file',
    input: {
      path: 'notes/new.txt',
      content: 'draft\n'
    }
  }, {
    cwd: workspaceRoot
  });

  assert.equal(approvalResult.status, 'requires_approval');

  const writeResult = await executor.executeToolCall({
    toolName: 'write_file',
    input: {
      path: 'notes/new.txt',
      content: 'draft\n'
    },
    metadata: {
      approved: true
    }
  }, {
    cwd: workspaceRoot
  });

  assert.equal(writeResult.status, 'completed');
  assert.equal(await readFile(path.join(workspaceRoot, 'notes', 'new.txt'), 'utf8'), 'draft\n');

  const replaceResult = await executor.executeToolCall({
    toolName: 'replace_in_file',
    input: {
      path: 'notes/todo.txt',
      oldText: 'world',
      newText: 'team'
    },
    metadata: {
      approved: true
    }
  }, {
    cwd: workspaceRoot
  });

  assert.equal(replaceResult.status, 'completed');
  assert.equal(replaceResult.structured.replaced, 1);
  assert.equal(await readFile(path.join(workspaceRoot, 'notes', 'todo.txt'), 'utf8'), 'hello team\n');
});

test('AssistantToolsExecutor autoApproveAll context skips per-tool confirmation for mutating tools', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'assistant-tools-yolo-'));
  const { registry, workspaceGuard } = createBuiltinAssistantToolRegistry({ workspaceRoot });
  const executor = new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: new AssistantToolPolicyService({
      workspaceGuard,
      allowMutatingTools: true
    })
  });

  const requiresApproval = await executor.executeToolCall({
    toolName: 'write_file',
    input: { path: 'notes.txt', content: 'hello' }
  }, { cwd: workspaceRoot });
  assert.equal(requiresApproval.status, 'requires_approval');

  const autoApproved = await executor.executeToolCall({
    toolName: 'write_file',
    input: { path: 'notes.txt', content: 'hello' }
  }, { cwd: workspaceRoot, autoApproveAll: true });
  assert.equal(autoApproved.status, 'completed');
  assert.equal(autoApproved.metadata?.policy?.autoApproved, true);
});

test('AssistantToolPolicyService allows desktop mutating tools without per-call approval', () => {
  const workspaceRoot = path.resolve('D:/tmp/policy-desktop-tools');
  const workspaceGuard = new WorkspaceGuard({ workspaceRoot });
  const policy = new AssistantToolPolicyService({
    workspaceGuard,
    allowMutatingTools: true
  });

  const decision = policy.evaluateToolCall({
    tool: { name: 'desktop_focus_window', mutating: true, requiresApproval: false },
    invocation: { input: { windowHwnd: 123 } },
    context: { cwd: workspaceRoot }
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, false);
});

test('AssistantToolsExecutor extraReadRoots context lets read_file reach files outside the workspace', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'assistant-tools-readroot-'));
  const skillRoot = await mkdtemp(path.join(os.tmpdir(), 'assistant-tools-skillroot-'));
  await writeFile(path.join(skillRoot, 'SKILL.md'), '# skill body', 'utf8');

  const { registry, workspaceGuard } = createBuiltinAssistantToolRegistry({ workspaceRoot });
  const executor = new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: new AssistantToolPolicyService({ workspaceGuard })
  });

  const denied = await executor.executeToolCall({
    toolName: 'read_file',
    input: { path: path.join(skillRoot, 'SKILL.md') }
  }, { cwd: workspaceRoot });
  assert.equal(denied.status, 'denied');
  assert.equal(denied.structured?.reason, 'path_outside_workspace');

  const allowed = await executor.executeToolCall({
    toolName: 'read_file',
    input: { path: path.join(skillRoot, 'SKILL.md') }
  }, { cwd: workspaceRoot, extraReadRoots: [skillRoot] });
  assert.equal(allowed.status, 'completed');
  assert.match(allowed.structured?.text || '', /skill body/);
});

test('AssistantToolsExecutor runs shell commands inside the workspace when approved', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'assistant-tools-shell-'));
  const { registry, workspaceGuard } = createBuiltinAssistantToolRegistry({ workspaceRoot });
  const executor = new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: new AssistantToolPolicyService({
      workspaceGuard,
      allowMutatingTools: true
    })
  });

  const command = process.platform === 'win32'
    ? 'echo assistant-tools'
    : 'printf assistant-tools';

  const shellResult = await executor.executeToolCall({
    toolName: 'run_shell_command',
    input: {
      command
    },
    metadata: {
      approved: true
    }
  }, {
    cwd: workspaceRoot
  });

  assert.equal(shellResult.status, 'completed');
  assert.equal(shellResult.structured.success, true);
  assert.match(shellResult.structured.stdout, /assistant-tools/i);
});

test('AssistantToolsExecutor returns multimodal image content for view_image', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'assistant-tools-image-'));
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7d0AAAAASUVORK5CYII=';
  await writeFile(path.join(workspaceRoot, 'pixel.png'), Buffer.from(imageBase64, 'base64'));

  const { registry, workspaceGuard } = createBuiltinAssistantToolRegistry({ workspaceRoot });
  const executor = new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: new AssistantToolPolicyService({ workspaceGuard })
  });

  const result = await executor.executeToolCall({
    toolName: 'view_image',
    input: {
      path: 'pixel.png',
      detail: 'high'
    }
  }, {
    cwd: workspaceRoot
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.structured.path, 'pixel.png');
  assert.equal(result.structured.media_type, 'image/png');
  assert.equal(result.structured.content[0].type, 'image');
  assert.equal(result.structured.content[0].source?.type, 'base64');
  assert.equal(result.structured.content[0].source?.media_type, 'image/png');
  assert.ok(String(result.structured.content[0].source?.data || '').length > 0);
  assert.match(String(result.structured.imageUrl || ''), /^data:image\/png;base64,/);
});

test('AssistantMcpService builds namespaced MCP identities and bridges tool/resource operations', async () => {
  const mcpService = new AssistantMcpService({
    servers: [{
      name: 'docs',
      tools: [
        {
          name: 'search',
          description: 'Search docs',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' }
            }
          }
        },
        {
          name: 'search docs',
          description: 'Search docs with a raw MCP name that needs sanitizing',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' }
            }
          }
        }
      ],
      resources: [{
        uri: 'docs://intro',
        name: 'Intro'
      }]
    }],
    resources: {
      'docs:docs://intro': {
        uri: 'docs://intro',
        mimeType: 'text/plain',
        text: 'hello docs'
      }
    },
    toolResultFactory({ serverName, toolName, arguments: args }) {
      return {
        serverName,
        toolName,
        echoed: args
      };
    }
  });

  assert.equal(buildNamespacedMcpToolName('docs', 'search'), 'mcp__docs__search');
  assert.deepEqual(parseNamespacedMcpToolName('mcp__docs__search'), {
    serverName: 'docs',
    toolName: 'search'
  });

  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'assistant-tools-mcp-'));
  const { registry, workspaceGuard } = createBuiltinAssistantToolRegistry({
    workspaceRoot,
    mcpService
  });
  const executor = new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: new AssistantToolPolicyService({
      workspaceGuard,
      allowMutatingTools: true
    })
  });

  const listServers = await executor.executeToolCall({
    toolName: 'list_mcp_servers',
    input: {}
  }, {
    cwd: workspaceRoot
  });
  assert.equal(listServers.status, 'completed');
  assert.equal(listServers.structured.servers.length, 1);
  assert.equal(listServers.structured.servers[0].name, 'docs');

  const listTools = await executor.executeToolCall({
    toolName: 'list_mcp_tools',
    input: { serverName: 'docs' }
  }, {
    cwd: workspaceRoot
  });
  assert.equal(listTools.status, 'completed');
  assert.equal(listTools.structured.tools[0].namespacedToolName, 'mcp__docs__search');

  const readResource = await executor.executeToolCall({
    toolName: 'read_mcp_resource',
    input: {
      serverName: 'docs',
      uri: 'docs://intro'
    }
  }, {
    cwd: workspaceRoot
  });
  assert.equal(readResource.status, 'completed');
  assert.equal(readResource.structured.resource.text, 'hello docs');

  const approvalNeeded = await executor.executeToolCall({
    toolName: 'call_mcp_tool',
    input: {
      namespacedToolName: 'mcp__docs__search',
      arguments: { query: 'hello' }
    }
  }, {
    cwd: workspaceRoot
  });
  assert.equal(approvalNeeded.status, 'requires_approval');

  const callTool = await executor.executeToolCall({
    toolName: 'call_mcp_tool',
    input: {
      namespacedToolName: 'mcp__docs__search',
      arguments: { query: 'hello' }
    },
    metadata: {
      approved: true
    }
  }, {
    cwd: workspaceRoot
  });
  assert.equal(callTool.status, 'completed');
  assert.equal(callTool.structured.namespacedToolName, 'mcp__docs__search');
  assert.equal(callTool.structured.result.echoed.query, 'hello');

  const sanitizedToolCall = await executor.executeToolCall({
    toolName: 'call_mcp_tool',
    input: {
      namespacedToolName: 'mcp__docs__search_docs',
      arguments: { query: 'legalized' }
    },
    metadata: {
      approved: true
    }
  }, {
    cwd: workspaceRoot
  });
  assert.equal(sanitizedToolCall.status, 'completed');
  assert.equal(sanitizedToolCall.structured.toolName, 'search docs');
  assert.equal(sanitizedToolCall.structured.result.echoed.query, 'legalized');

  const directApprovalNeeded = await executor.executeToolCall({
    toolName: 'mcp__docs__search',
    input: { query: 'hello' }
  }, {
    cwd: workspaceRoot
  });
  assert.equal(directApprovalNeeded.status, 'requires_approval');

  const directCall = await executor.executeToolCall({
    toolName: 'mcp__docs__search',
    input: { query: 'direct' },
    metadata: {
      approved: true
    }
  }, {
    cwd: workspaceRoot
  });
  assert.equal(directCall.status, 'completed');
  assert.equal(directCall.structured.toolName, 'search');
  assert.equal(directCall.structured.result.echoed.query, 'direct');
});

test('call_mcp_tool preserves uniqued namespaced identity for colliding MCP names', async () => {
  const mcpService = new AssistantMcpService({
    servers: [{
      name: 'docs',
      tools: [
        { name: 'search docs' },
        { name: 'search/docs' }
      ]
    }],
    toolResultFactory({ toolName }) {
      return { toolName };
    }
  });
  const [firstTool, secondTool] = mcpService.listTools({ serverName: 'docs' });
  assert.equal(firstTool.namespacedToolName, 'mcp__docs__search_docs');
  assert.notEqual(secondTool.namespacedToolName, 'mcp__docs__search_docs');

  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'assistant-tools-mcp-collide-'));
  const { registry, workspaceGuard } = createBuiltinAssistantToolRegistry({
    workspaceRoot,
    mcpService
  });
  const executor = new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: new AssistantToolPolicyService({
      workspaceGuard,
      allowMutatingTools: true
    })
  });

  const result = await executor.executeToolCall({
    toolName: 'call_mcp_tool',
    input: {
      namespacedToolName: secondTool.namespacedToolName,
      arguments: {}
    },
    metadata: {
      approved: true
    }
  }, {
    cwd: workspaceRoot
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.structured.toolName, 'search/docs');
  assert.equal(result.structured.namespacedToolName, secondTool.namespacedToolName);
  assert.equal(result.structured.result.toolName, 'search/docs');
});

test('runAssistantToolLoop stops on denial when requested', async () => {
  const registry = new AssistantToolsRegistry();
  registry.register({
    name: 'read_file',
    execute: async () => ({ ok: true })
  });
  const executor = new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: {
      evaluateToolCall({ invocation }) {
        if (invocation.toolName === 'blocked_tool') {
          return {
            allowed: false,
            requiresApproval: false,
            reason: 'tool_not_allowed',
            grantedPermissions: { read: [], write: [] }
          };
        }
        return {
          allowed: true,
          requiresApproval: false,
          reason: null,
          grantedPermissions: { read: [], write: [] }
        };
      }
    }
  });

  const loopResult = await runAssistantToolLoop({
    executor,
    stopOnError: true,
    calls: [
      { toolName: 'read_file', input: {} },
      { toolName: 'blocked_tool', input: {} },
      { toolName: 'read_file', input: {} }
    ]
  });

  assert.equal(loopResult.results.length, 2);
  assert.equal(loopResult.results[1].result.status, 'denied');
});

test('AssistantToolsExecutor refuses tool_use with missing required fields and never reaches the handler', async () => {
  // Regression guard for the pptx-skill run where the supervisor's write_file
  // tool_use arrived with input={} because Azure GPT-5.4 truncated the
  // arguments JSON. The handler then tried mkdir('D:\\') and the LLM concluded
  // it was a permissions bug. The executor must catch this before the handler
  // ever runs.
  const registry = new AssistantToolsRegistry();
  let handlerInvoked = false;
  registry.register({
    name: 'write_file',
    description: 'write file',
    mutating: true,
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content']
    },
    execute: async () => {
      handlerInvoked = true;
      return { ok: true };
    }
  });

  const executor = new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: {
      evaluateToolCall: () => ({
        allowed: true,
        requiresApproval: false,
        reason: null,
        grantedPermissions: { read: [], write: [] },
        autoApproved: true
      })
    }
  });

  const result = await executor.executeToolCall({
    toolName: 'write_file',
    input: {}
  }, { cwd: 'D:/' });

  assert.equal(result.status, 'failed');
  assert.equal(result.structured?.kind, 'invalid_input');
  assert.equal(result.structured?.reason, 'tool_arguments_missing_required');
  assert.deepEqual(result.structured?.missing, ['path', 'content']);
  assert.equal(handlerInvoked, false, 'handler must not run when required fields are missing');
});

test('AssistantToolsExecutor treats __truncated input as a recoverable failure', async () => {
  const registry = new AssistantToolsRegistry();
  let handlerInvoked = false;
  registry.register({
    name: 'write_file',
    description: 'write file',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content']
    },
    execute: async () => {
      handlerInvoked = true;
      return { ok: true };
    }
  });

  const executor = new AssistantToolsExecutor({
    toolRegistry: registry,
    policyService: {
      evaluateToolCall: () => ({
        allowed: true,
        requiresApproval: false,
        reason: null,
        grantedPermissions: { read: [], write: [] }
      })
    }
  });

  const result = await executor.executeToolCall({
    toolName: 'write_file',
    input: { __truncated: true, path: 'a.txt' }
  }, { cwd: 'D:/' });

  assert.equal(result.status, 'failed');
  assert.equal(result.structured?.kind, 'invalid_input');
  assert.equal(result.structured?.reason, 'tool_arguments_truncated');
  assert.equal(result.structured?.truncated, true);
  assert.equal(handlerInvoked, false);
});

test('createBuiltinAssistantToolRegistry includes desktop read-only tools', () => {
  const { registry } = createBuiltinAssistantToolRegistry({ workspaceRoot: process.cwd() });
  const toolNames = registry.list({ visibility: 'direct' }).map((tool) => tool.name);

  assert.ok(toolNames.includes('desktop_health'));
  assert.ok(toolNames.includes('desktop_list_windows'));
  assert.ok(toolNames.includes('desktop_launch_app'));
  assert.ok(toolNames.includes('desktop_focus_window'));
  assert.ok(toolNames.includes('desktop_find_control'));
  assert.ok(toolNames.includes('desktop_click_control'));
  assert.ok(toolNames.includes('desktop_set_control_value'));
  assert.ok(toolNames.includes('desktop_send_control_keys'));
  assert.ok(toolNames.includes('desktop_get_control_text'));
  assert.ok(toolNames.includes('desktop_wait_for_control'));
  assert.ok(toolNames.includes('desktop_capture_window'));
});
