/**
 * Unit tests for src/kilo-format-converter.js
 * Tests Anthropic ↔ OpenAI Chat Completions format conversion.
 * No server required — pure logic tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convertAnthropicToOpenAIChat,
  convertOpenAIChatToAnthropic
} from '../../src/kilo-format-converter.js';

// ─── convertAnthropicToOpenAIChat ─────────────────────────────────────────────

test('convertAnthropicToOpenAIChat: basic user message', () => {
  const req = {
    messages: [{ role: 'user', content: 'hello' }]
  };
  const result = convertAnthropicToOpenAIChat(req, 'minimax/minimax-m2.5:free');
  assert.equal(result.model, 'minimax/minimax-m2.5:free');
  assert.ok(Array.isArray(result.messages));
  const userMsg = result.messages.find(m => m.role === 'user');
  assert.ok(userMsg);
  assert.equal(userMsg.content, 'hello');
});

test('convertAnthropicToOpenAIChat: string system prompt becomes system message', () => {
  const req = {
    system: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'hi' }]
  };
  const result = convertAnthropicToOpenAIChat(req, 'moonshotai/kimi-k2.5:free');
  const sysMsg = result.messages.find(m => m.role === 'system');
  assert.ok(sysMsg, 'Expected system message');
  assert.equal(sysMsg.content, 'You are a helpful assistant.');
});

test('convertAnthropicToOpenAIChat: array system prompt joins text blocks', () => {
  const req = {
    system: [
      { type: 'text', text: 'Block one.' },
      { type: 'text', text: 'Block two.' }
    ],
    messages: [{ role: 'user', content: 'hi' }]
  };
  const result = convertAnthropicToOpenAIChat(req, 'moonshotai/kimi-k2.5:free');
  const sysMsg = result.messages.find(m => m.role === 'system');
  assert.equal(sysMsg.content, 'Block one.\n\nBlock two.');
});

test('convertAnthropicToOpenAIChat: no system → no system message', () => {
  const req = { messages: [{ role: 'user', content: 'hi' }] };
  const result = convertAnthropicToOpenAIChat(req, 'moonshotai/kimi-k2.5:free');
  const sysMsg = result.messages.find(m => m.role === 'system');
  assert.equal(sysMsg, undefined);
});

test('convertAnthropicToOpenAIChat: user content as array of text blocks', () => {
  const req = {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'First part.' },
        { type: 'text', text: 'Second part.' }
      ]
    }]
  };
  const result = convertAnthropicToOpenAIChat(req, 'moonshotai/kimi-k2.5:free');
  const userMsg = result.messages.find(m => m.role === 'user');
  assert.ok(userMsg.content.includes('First part.'));
  assert.ok(userMsg.content.includes('Second part.'));
});

test('convertAnthropicToOpenAIChat: tool_result becomes tool role message', () => {
  const req = {
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_abc',
        content: 'search results here'
      }]
    }]
  };
  const result = convertAnthropicToOpenAIChat(req, 'moonshotai/kimi-k2.5:free');
  const toolMsg = result.messages.find(m => m.role === 'tool');
  assert.ok(toolMsg, 'Expected tool message');
  assert.equal(toolMsg.tool_call_id, 'fc_abc');
  assert.equal(toolMsg.content, 'search results here');
});

test('convertAnthropicToOpenAIChat: assistant tool_use becomes tool_calls', () => {
  const req = {
    messages: [{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'call_xyz',
        name: 'search',
        input: { query: 'test' }
      }]
    }]
  };
  const result = convertAnthropicToOpenAIChat(req, 'moonshotai/kimi-k2.5:free');
  const assistantMsg = result.messages.find(m => m.role === 'assistant');
  assert.ok(assistantMsg, 'Expected assistant message');
  assert.ok(Array.isArray(assistantMsg.tool_calls));
  assert.equal(assistantMsg.tool_calls[0].id, 'fc_xyz');
  assert.equal(assistantMsg.tool_calls[0].function.name, 'search');
  assert.equal(assistantMsg.tool_calls[0].function.arguments, JSON.stringify({ query: 'test' }));
});

test('convertAnthropicToOpenAIChat: stream defaults to true', () => {
  const req = { messages: [{ role: 'user', content: 'hi' }] };
  const result = convertAnthropicToOpenAIChat(req, 'moonshotai/kimi-k2.5:free');
  assert.equal(result.stream, true);
});

test('convertAnthropicToOpenAIChat: stream: false is respected', () => {
  const req = { messages: [{ role: 'user', content: 'hi' }], stream: false };
  const result = convertAnthropicToOpenAIChat(req, 'moonshotai/kimi-k2.5:free');
  assert.equal(result.stream, false);
});

test('convertAnthropicToOpenAIChat: max_tokens is forwarded', () => {
  const req = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 };
  const result = convertAnthropicToOpenAIChat(req, 'moonshotai/kimi-k2.5:free');
  assert.equal(result.max_tokens, 100);
});

test('convertAnthropicToOpenAIChat: temperature and top_p are forwarded', () => {
  const req = {
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.7,
    top_p: 0.9
  };
  const result = convertAnthropicToOpenAIChat(req, 'moonshotai/kimi-k2.5:free');
  assert.equal(result.temperature, 0.7);
  assert.equal(result.top_p, 0.9);
});

test('convertAnthropicToOpenAIChat: stop_sequences maps to stop', () => {
  const req = {
    messages: [{ role: 'user', content: 'hi' }],
    stop_sequences: ['STOP', 'END']
  };
  const result = convertAnthropicToOpenAIChat(req, 'moonshotai/kimi-k2.5:free');
  assert.deepEqual(result.stop, ['STOP', 'END']);
});

test('convertAnthropicToOpenAIChat: tools are converted to function format', () => {
  const req = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      name: 'get_weather',
      description: 'Get weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' } } }
    }]
  };
  const result = convertAnthropicToOpenAIChat(req, 'moonshotai/kimi-k2.5:free');
  assert.ok(Array.isArray(result.tools));
  assert.equal(result.tools[0].type, 'function');
  assert.equal(result.tools[0].function.name, 'get_weather');
});

test('convertAnthropicToOpenAIChat: tool_choice with specific tool name', () => {
  const req = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'search', description: 'd', input_schema: { type: 'object' } }],
    tool_choice: { type: 'tool', name: 'search' }
  };
  const result = convertAnthropicToOpenAIChat(req, 'moonshotai/kimi-k2.5:free');
  assert.deepEqual(result.tool_choice, { type: 'function', function: { name: 'search' } });
});

test('convertAnthropicToOpenAIChat: hosted tools are omitted from chat tool list', () => {
  const req = {
    messages: [{ role: 'user', content: 'search the web' }],
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 3
    }],
    tool_choice: { type: 'tool', name: 'web_search' }
  };

  const result = convertAnthropicToOpenAIChat(req, 'moonshotai/kimi-k2.5:free');
  assert.equal(result.tools, undefined);
  assert.equal(result.tool_choice, 'auto');
});

test('convertAnthropicToOpenAIChat: empty messages array', () => {
  const req = { messages: [] };
  const result = convertAnthropicToOpenAIChat(req, 'moonshotai/kimi-k2.5:free');
  assert.ok(Array.isArray(result.messages));
  assert.equal(result.messages.length, 0);
});

// ─── convertOpenAIChatToAnthropic ─────────────────────────────────────────────

test('convertOpenAIChatToAnthropic: basic text response', () => {
  const openAiResp = {
    choices: [{
      message: { content: 'Hello there!', tool_calls: null },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  };
  const result = convertOpenAIChatToAnthropic(openAiResp);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[0].text, 'Hello there!');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 5);
});

test('convertOpenAIChatToAnthropic: tool_calls finish_reason maps to tool_use', () => {
  const openAiResp = {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'search', arguments: '{"q":"test"}' }
        }]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 5, completion_tokens: 10 }
  };
  const result = convertOpenAIChatToAnthropic(openAiResp);
  assert.equal(result.stopReason, 'tool_use');
  const toolUse = result.content.find(c => c.type === 'tool_use');
  assert.ok(toolUse, 'Expected tool_use block');
  assert.equal(toolUse.name, 'search');
  assert.deepEqual(toolUse.input, { q: 'test' });
  assert.equal(toolUse.id, 'toolu_call_1');
});

test('convertOpenAIChatToAnthropic: invalid tool_calls arguments → empty input', () => {
  const openAiResp = {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: 'call_bad',
          type: 'function',
          function: { name: 'tool', arguments: 'INVALID_JSON' }
        }]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 }
  };
  const result = convertOpenAIChatToAnthropic(openAiResp);
  const toolUse = result.content.find(c => c.type === 'tool_use');
  assert.deepEqual(toolUse.input, {});
});

test('convertOpenAIChatToAnthropic: empty content → default text block', () => {
  const openAiResp = {
    choices: [{
      message: { content: null, tool_calls: null },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0 }
  };
  const result = convertOpenAIChatToAnthropic(openAiResp);
  assert.deepEqual(result.content, [{ type: 'text', text: '' }]);
});

test('convertOpenAIChatToAnthropic: null/undefined response → graceful fallback', () => {
  const result = convertOpenAIChatToAnthropic(null);
  assert.ok(Array.isArray(result.content));
  assert.equal(result.usage.input_tokens, 0);
  assert.equal(result.usage.output_tokens, 0);
});

test('convertOpenAIChatToAnthropic: mixed text + tool_calls', () => {
  const openAiResp = {
    choices: [{
      message: {
        content: 'Let me search for that.',
        tool_calls: [{
          id: 'call_2',
          type: 'function',
          function: { name: 'search', arguments: '{"q":"info"}' }
        }]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20 }
  };
  const result = convertOpenAIChatToAnthropic(openAiResp);
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[1].type, 'tool_use');
});

test('convertOpenAIChatToAnthropic: usage defaults to 0 when missing', () => {
  const openAiResp = {
    choices: [{
      message: { content: 'hi', tool_calls: null },
      finish_reason: 'stop'
    }]
  };
  const result = convertOpenAIChatToAnthropic(openAiResp);
  assert.equal(result.usage.input_tokens, 0);
  assert.equal(result.usage.output_tokens, 0);
});

test('convertOpenAIChatToAnthropic: handles MiniMax M2.5 reasoning field', () => {
    const openAiResp = {
        choices: [{
            message: { 
                content: null, 
                reasoning: 'Thinking about the answer...', 
                tool_calls: null 
            },
            finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
    };
    const result = convertOpenAIChatToAnthropic(openAiResp);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'thinking');
    assert.equal(result.content[0].thinking, 'Thinking about the answer...');
});

test('convertOpenAIChatToAnthropic: handles MiniMax M2.5 reasoning + tool_calls', () => {
    const openAiResp = {
        choices: [{
            message: { 
                content: null, 
                reasoning: 'I need to use a tool.', 
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_time', arguments: '{}' }
                }] 
            },
            finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20 }
    };
    const result = convertOpenAIChatToAnthropic(openAiResp);
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'thinking');
    assert.equal(result.content[1].type, 'tool_use');
    assert.equal(result.stopReason, 'tool_use');
});
