import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeAssistantReply } from '../../src/assistant-agent/response-composer.js';

function policyBlockEntry(toolName, input, reason = 'mutating_tool_requires_confirmation') {
  return {
    toolName,
    input,
    status: 'requires_approval',
    summary: `Tool call requires approval: ${reason}`,
    result: {
      kind: 'policy_block',
      toolName,
      reason,
      requiresApproval: true,
      requiresConfirmation: true
    }
  };
}

test('confirmation message explains run_shell_command (what + risk + command), not the raw reason code', () => {
  const reply = composeAssistantReply({
    language: 'zh-CN',
    toolResults: [policyBlockEntry('run_shell_command', {
      command: "powershell -NoProfile -Command \"Get-ChildItem -Path 'D:\\'\"",
      cwd: 'D:\\'
    })],
    finalStatus: 'waiting_user',
    stopReason: 'assistant_confirmation_required'
  });
  // Must NOT leak the opaque code to the end user.
  assert.ok(!/mutating_tool_requires_confirmation/.test(reply.message), 'raw reason code must not be shown');
  // Must explain what the tool is and that it is higher risk.
  assert.match(reply.message, /命令|系统命令|shell/i);
  assert.match(reply.message, /风险|确认/);
  // Should surface the actual command / scope so the user knows what they approve.
  assert.match(reply.message, /Get-ChildItem|D:\\/);
  // Should tell the user how to approve / how to stop being asked.
  assert.match(reply.message, /同意|确认/);
});

test('confirmation message describes a file-write tool with the target path', () => {
  const reply = composeAssistantReply({
    language: 'zh-CN',
    toolResults: [policyBlockEntry('write_file', { path: 'D:\\notes\\todo.md' })],
    finalStatus: 'waiting_user',
    stopReason: 'assistant_confirmation_required'
  });
  assert.ok(!/mutating_tool_requires_confirmation/.test(reply.message));
  assert.match(reply.message, /写入|修改|文件/);
  assert.match(reply.message, /todo\.md/);
});

test('English confirmation message is also descriptive, not a raw code', () => {
  const reply = composeAssistantReply({
    language: 'en',
    toolResults: [policyBlockEntry('run_shell_command', { command: 'rm -rf /tmp/x', cwd: '/tmp' })],
    finalStatus: 'waiting_user',
    stopReason: 'assistant_confirmation_required'
  });
  assert.ok(!/mutating_tool_requires_confirmation/.test(reply.message));
  assert.match(reply.message, /command|shell/i);
  assert.match(reply.message, /rm -rf/);
});

test('unknown mutating tool falls back to a generic-but-named explanation', () => {
  const reply = composeAssistantReply({
    language: 'zh-CN',
    toolResults: [policyBlockEntry('some_custom_tool', { foo: 'bar' })],
    finalStatus: 'waiting_user',
    stopReason: 'assistant_confirmation_required'
  });
  assert.ok(!/mutating_tool_requires_confirmation/.test(reply.message));
  assert.match(reply.message, /some_custom_tool/);
  assert.match(reply.message, /确认/);
});
