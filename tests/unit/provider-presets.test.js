import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PROVIDER_PRESETS,
    PRESET_BY_ID,
    presetIds,
    presetIdsByFormat,
    presetPricing,
    presetTierMappings,
    presetUiList,
} from '../../src/providers/provider-presets.js';
import { i18n } from '../../public/js/i18n.js';
import { makeOpenAICompatibleProvider } from '../../src/providers/openai-compatible.js';
import { addApiKey, removeApiKey, getProviderById } from '../../src/api-key-manager.js';
import { resolveModel } from '../../src/model-mapping.js';
import { getEffectivePricing } from '../../src/pricing-registry.js';
import { listAvailableCredentials } from '../../src/assistant-agent/credential-resolver.js';
import { translateAnthropicToOpenAIChatRequest } from '../../src/translators/request/anthropic-to-openai-chat.js';
import { translateOpenAIChatToAnthropicMessage } from '../../src/translators/response/openai-chat-to-anthropic.js';

test('every preset declares the required fields and a unique id', () => {
    const ids = presetIds();
    assert.equal(new Set(ids).size, ids.length, 'preset ids must be unique');
    for (const preset of PROVIDER_PRESETS) {
        assert.ok(preset.id, 'id required');
        assert.ok(preset.label, `label required for ${preset.id}`);
        assert.ok(preset.apiFormat, `apiFormat required for ${preset.id}`);
        assert.ok(preset.baseUrl, `baseUrl required for ${preset.id}`);
    }
});

test('this batch ships qwen + openrouter as openai_chat presets', () => {
    assert.deepEqual(presetIdsByFormat('openai_chat').sort(), ['openrouter', 'qwen']);
    // Nothing in this batch should claim the Responses or Anthropic formats.
    assert.deepEqual(presetIdsByFormat('openai_responses'), []);
    assert.deepEqual(presetIdsByFormat('anthropic'), []);
});

test('generic openai_chat provider serves chat + Anthropic bridge, but NOT native Responses', () => {
    for (const preset of PROVIDER_PRESETS) {
        const Cls = makeOpenAICompatibleProvider(preset);
        const instance = new Cls({ id: `tmp_${preset.id}`, apiKey: 'sk-test' });
        assert.equal(instance.type, preset.id);
        assert.equal(typeof instance.sendRequest, 'function', `${preset.id} must serve the chat path`);
        // Claude Code (/v1/messages) is served via the Anthropic⇄Chat bridge.
        assert.equal(typeof instance.sendAnthropicRequest, 'function', `${preset.id} must serve /v1/messages`);
        // Codex must take responses-route's chat fallback, so there must be NO
        // native sendResponsesRequest (that would trigger the native branch).
        assert.equal(instance.sendResponsesRequest, undefined, `${preset.id} must NOT claim native /responses`);
    }
});

test('an added qwen key is now bindable by the assistant (has Anthropic bridge)', () => {
    const { success, id } = addApiKey({ type: 'qwen', name: 'bind-qwen', apiKey: 'sk-bind' });
    assert.equal(success, true, 'qwen must be a registered, addable provider type');
    try {
        const provider = getProviderById(id);
        assert.equal(provider.type, 'qwen');
        assert.equal(typeof provider.sendAnthropicRequest, 'function');

        const available = listAvailableCredentials();
        assert.ok(Array.isArray(available.apiKeys.qwen), 'qwen should now appear in assistant bindable credentials');
        assert.ok(available.apiKeys.qwen.some((c) => c.id === id), 'the added qwen key should be listed');
    } finally {
        removeApiKey(id);
    }
});

test('Anthropic⇄Chat translator round-trips text, tools, and tool results', () => {
    const anthropicReq = {
        model: 'qwen-plus',
        max_tokens: 256,
        temperature: 0.4,
        system: 'You are helpful.',
        tools: [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
        tool_choice: { type: 'auto' },
        messages: [
            { role: 'user', content: 'Weather in Paris?' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '18°C' }] }
        ]
    };
    const chat = translateAnthropicToOpenAIChatRequest(anthropicReq);
    assert.equal(chat.model, 'qwen-plus');
    assert.equal(chat.max_tokens, 256);
    assert.equal(chat.stream, false);
    assert.equal(chat.messages[0].role, 'system');
    // system + user + assistant(tool_calls) + tool
    assert.equal(chat.messages[1].role, 'user');
    const assistantMsg = chat.messages.find((m) => m.role === 'assistant');
    assert.equal(assistantMsg.tool_calls[0].function.name, 'get_weather');
    assert.equal(JSON.parse(assistantMsg.tool_calls[0].function.arguments).city, 'Paris');
    const toolMsg = chat.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.tool_call_id, 'toolu_1');
    assert.equal(chat.tools[0].function.name, 'get_weather');
    assert.equal(chat.tool_choice, 'auto');

    const chatResponse = {
        id: 'chatcmpl-abc',
        model: 'qwen-plus',
        choices: [{ message: { content: 'It is 18°C in Paris.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 7 }
    };
    const msg = translateOpenAIChatToAnthropicMessage(chatResponse, { model: 'qwen-plus' });
    assert.equal(msg.type, 'message');
    assert.equal(msg.role, 'assistant');
    assert.equal(msg.content[0].type, 'text');
    assert.match(msg.content[0].text, /18°C/);
    assert.equal(msg.stop_reason, 'end_turn');
    assert.equal(msg.usage.input_tokens, 12);
    assert.equal(msg.usage.output_tokens, 7);
});

test('Chat→Anthropic maps tool_calls to tool_use with stop_reason tool_use', () => {
    const chatResponse = {
        choices: [{
            message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'search', arguments: '{"q":"x"}' } }] },
            finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3 }
    };
    const msg = translateOpenAIChatToAnthropicMessage(chatResponse, { model: 'qwen-max' });
    const toolUse = msg.content.find((b) => b.type === 'tool_use');
    assert.ok(toolUse, 'should contain a tool_use block');
    assert.equal(toolUse.name, 'search');
    assert.deepEqual(toolUse.input, { q: 'x' });
    assert.equal(msg.stop_reason, 'tool_use');
});

test('resolveModel passes through native / slug models and tier-maps the rest', () => {
    // qwen: native prefix → pass through
    assert.equal(resolveModel('qwen', 'qwen-max'), 'qwen-max');
    // qwen: non-native → tier mapping kicks in (does not stay verbatim)
    assert.notEqual(resolveModel('qwen', 'claude-sonnet-4-6'), 'claude-sonnet-4-6');
    // openrouter: vendor/model slug → pass through verbatim
    assert.equal(resolveModel('openrouter', 'anthropic/claude-3.7-sonnet'), 'anthropic/claude-3.7-sonnet');
});

test('provider display names are internationalized (CN/EN switchable)', () => {
    // Every preset that carries a labelKey must resolve in BOTH locales.
    for (const { id, labelKey } of presetUiList()) {
        if (!labelKey) continue;
        assert.ok(i18n.en[labelKey], `missing EN i18n for ${id} (${labelKey})`);
        assert.ok(i18n.zh[labelKey], `missing ZH i18n for ${id} (${labelKey})`);
    }
    // Qwen specifically: English brand vs Chinese name.
    assert.equal(PRESET_BY_ID.qwen.labelKey, 'providerQwen');
    assert.equal(i18n.en.providerQwen, 'Qwen');
    assert.equal(i18n.zh.providerQwen, '通义千问');
    // The neutral default label must not be locale-specific Chinese.
    assert.equal(PRESET_BY_ID.qwen.label, 'Qwen');
});

test('preset pricing is merged into the registry; openrouter stays unpriced (0)', () => {
    assert.ok(presetTierMappings().qwen, 'qwen tier map present');
    const qwen = getEffectivePricing('qwen', 'qwen-max');
    assert.ok(qwen && qwen.input > 0, 'qwen-max should be priced');
    assert.equal(getEffectivePricing('openrouter', 'anthropic/claude-3.7-sonnet'), null, 'openrouter has no built-in pricing');
});
