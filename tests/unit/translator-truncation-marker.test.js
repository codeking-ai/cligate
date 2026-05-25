import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { convertResponsesOutputToAnthropicContent } from '../../src/translators/shared/content-blocks.js';

test('translator marks function_call with truncated arguments JSON and preserves the raw text', () => {
  // Simulates Azure GPT-5.4 hitting max_output_tokens mid tool_use arguments.
  // Pre-fix this path silently returned input={}, which then crashed
  // writeFile inside mkdir('D:\\'). The translator must surface __truncated
  // so the executor and ReAct engine can recover instead of executing the
  // broken call.
  const output = [
    {
      type: 'function_call',
      id: 'call_1',
      call_id: 'call_1',
      name: 'write_file',
      arguments: '{"path":"D:/beijing/script.js","content":"const pres = '
    }
  ];

  const blocks = convertResponsesOutputToAnthropicContent(output);
  const toolUse = blocks.find((block) => block.type === 'tool_use');

  assert.ok(toolUse, 'expected a tool_use block');
  assert.equal(toolUse.name, 'write_file');
  assert.equal(toolUse.__truncated, true);
  assert.equal(toolUse.input && typeof toolUse.input === 'object', true);
  assert.match(toolUse.__rawArguments || '', /"path":"D:\/beijing/);
});

test('translator leaves valid arguments untouched (no __truncated flag)', () => {
  const output = [
    {
      type: 'function_call',
      id: 'call_2',
      call_id: 'call_2',
      name: 'read_file',
      arguments: '{"path":"a.md","maxBytes":1024}'
    }
  ];

  const blocks = convertResponsesOutputToAnthropicContent(output);
  const toolUse = blocks.find((block) => block.type === 'tool_use');

  assert.ok(toolUse);
  assert.equal(toolUse.__truncated, undefined);
  assert.deepEqual(toolUse.input, { path: 'a.md', maxBytes: 1024 });
});

test('translator accepts pre-parsed arguments object without flagging truncation', () => {
  const output = [
    {
      type: 'function_call',
      id: 'call_3',
      call_id: 'call_3',
      name: 'write_file',
      arguments: { path: 'a.js', content: 'x' }
    }
  ];

  const blocks = convertResponsesOutputToAnthropicContent(output);
  const toolUse = blocks.find((block) => block.type === 'tool_use');

  assert.equal(toolUse.__truncated, undefined);
  assert.deepEqual(toolUse.input, { path: 'a.js', content: 'x' });
});
