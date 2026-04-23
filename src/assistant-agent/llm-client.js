import { listAccounts as listChatGptAccounts } from '../account-manager.js';
import {
  getAccount as getClaudeAccount,
  getUsableAccounts,
  listAccounts as listClaudeAccounts
} from '../claude-account-manager.js';
import { getCredentialsForAccount } from '../middleware/credentials.js';
import { sendMessageStream } from '../direct-api.js';
import { sendClaudeMessageWithMeta, mapToClaudeModel } from '../claude-api.js';
import { selectKey } from '../api-key-manager.js';
import { resolveModel } from '../model-mapping.js';
import { getServerSettings } from '../server-settings.js';

function pickChatGptAccount() {
  const snapshot = listChatGptAccounts();
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts.filter((entry) => entry.enabled !== false) : [];
  if (accounts.length === 0) return null;
  return accounts.find((entry) => entry.email === snapshot.activeAccount) || accounts[0];
}

function pickClaudeAccount() {
  const usable = typeof getUsableAccounts === 'function' ? getUsableAccounts() : [];
  if (Array.isArray(usable) && usable.length > 0) {
    return usable[0];
  }
  const snapshot = listClaudeAccounts();
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts.filter((entry) => entry.enabled !== false) : [];
  if (accounts.length === 0) return null;
  return getClaudeAccount(snapshot.activeAccount) || getClaudeAccount(accounts[0].email) || null;
}

function normalizeAnthropicResponse(response = {}) {
  const content = Array.isArray(response?.content) ? response.content : [];
  const text = content
    .filter((entry) => entry?.type === 'text')
    .map((entry) => entry.text || '')
    .join('\n\n')
    .trim();
  const toolCalls = content
    .filter((entry) => entry?.type === 'tool_use')
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      input: entry.input || {}
    }));

  return {
    text,
    toolCalls,
    stopReason: response?.stop_reason || '',
    usage: response?.usage || null,
    raw: response
  };
}

async function sendChatGptAssistantRequest(request, creds, defaultModel) {
  const content = [];
  let usage = null;
  for await (const event of sendMessageStream({
    ...request,
    model: request.model || defaultModel,
    stream: true
  }, creds.accessToken, creds.accountId)) {
    if (event?.event === 'content_block_delta' && event.data?.delta?.type === 'text_delta') {
      content.push(event.data.delta.text || '');
    }
    if (event?.event === 'message_delta' && event.data?.usage) {
      usage = event.data.usage;
    }
  }

  return {
    text: content.join('').trim(),
    toolCalls: [],
    stopReason: 'end_turn',
    usage,
    raw: {
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'text',
        text: content.join('').trim()
      }],
      model: request.model || defaultModel,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage
    }
  };
}

async function parseJsonResponse(response) {
  if (!response?.ok) {
    const body = await response.text();
    throw new Error(body || `Assistant model request failed with ${response?.status || 500}`);
  }
  return response.json();
}

function sourceStatusRecord({
  key,
  label,
  enabled,
  available,
  selected = false,
  detail = '',
  kind = ''
} = {}) {
  return {
    key,
    label,
    enabled: enabled === true,
    available: available === true,
    selected: selected === true,
    detail: String(detail || ''),
    kind: String(kind || '')
  };
}

export class AssistantLlmClient {
  constructor({
    defaultChatGptModel = 'gpt-5.4',
    defaultClaudeModel = 'claude-sonnet-4-6',
    allowChatGptAccountSource = false,
    allowClaudeAccountSource = false,
    enabled = process.env.CLIGATE_ENABLE_ASSISTANT_AGENT !== '0'
  } = {}) {
    this.defaultChatGptModel = defaultChatGptModel;
    this.defaultClaudeModel = defaultClaudeModel;
    this.allowChatGptAccountSource = allowChatGptAccountSource === true;
    this.allowClaudeAccountSource = allowClaudeAccountSource === true;
    this.enabled = enabled === true;
  }

  getRuntimeConfig() {
    const settings = getServerSettings();
    const configured = settings?.assistantAgent && typeof settings.assistantAgent === 'object'
      ? settings.assistantAgent
      : null;
    return {
      enabled: configured ? configured.enabled === true : this.enabled,
      sources: {
        chatgptAccount: configured
          ? configured.sources?.chatgptAccount === true
          : this.allowChatGptAccountSource,
        claudeAccount: configured
          ? configured.sources?.claudeAccount === true
          : this.allowClaudeAccountSource,
        anthropicApiKey: configured
          ? configured.sources?.anthropicApiKey !== false
          : true,
        openaiApiKeyBridge: configured
          ? configured.sources?.openaiApiKeyBridge !== false
          : true,
        azureOpenaiApiKeyBridge: configured
          ? configured.sources?.azureOpenaiApiKeyBridge !== false
          : true
      }
    };
  }

  async hasAvailableSource() {
    if (!this.getRuntimeConfig().enabled) return false;
    const candidates = await this.listCandidateSources();
    return candidates.length > 0;
  }

  getFallbackReason() {
    const config = this.getRuntimeConfig();
    if (!config.enabled) {
      return 'assistant_agent_disabled';
    }
    return 'no_available_llm_source';
  }

  async listCandidateSources() {
    const config = this.getRuntimeConfig();
    if (!config.enabled) {
      throw new Error('Assistant LLM agent is disabled');
    }
    const candidates = [];
    const anthropicProvider = config.sources.anthropicApiKey ? selectKey('anthropic') : null;
    if (anthropicProvider) {
      candidates.push({
        kind: 'api-key',
        label: anthropicProvider.name,
        model: this.defaultClaudeModel,
        send: async (request) => normalizeAnthropicResponse(
          await parseJsonResponse(await anthropicProvider.sendRequest({
            ...request,
              model: mapToClaudeModel(request.model || this.defaultClaudeModel)
          }))
        )
      });
    }

    const openAiProvider = config.sources.openaiApiKeyBridge ? selectKey('openai') : null;
    if (openAiProvider?.sendAnthropicRequest) {
      candidates.push({
        kind: 'api-key',
        label: openAiProvider.name,
        model: this.defaultChatGptModel,
        send: async (request) => normalizeAnthropicResponse(
          await parseJsonResponse(await openAiProvider.sendAnthropicRequest({
            ...request,
            model: resolveModel(openAiProvider.type, request.model || this.defaultChatGptModel)
              || request.model
              || this.defaultChatGptModel
          }))
        )
      });
    }

    const azureProvider = config.sources.azureOpenaiApiKeyBridge ? selectKey('azure-openai') : null;
    if (azureProvider?.sendAnthropicRequest) {
      candidates.push({
        kind: 'api-key',
        label: azureProvider.name,
        model: this.defaultChatGptModel,
        send: async (request) => normalizeAnthropicResponse(
          await parseJsonResponse(await azureProvider.sendAnthropicRequest({
            ...request,
            model: resolveModel(azureProvider.type, request.model || this.defaultChatGptModel)
              || request.model
              || this.defaultChatGptModel
          }))
        )
      });
    }

    if (config.sources.claudeAccount) {
      const claudeAccount = pickClaudeAccount();
      if (claudeAccount?.accessToken) {
        candidates.push({
          kind: 'claude-account',
          label: claudeAccount.email || 'claude',
          model: this.defaultClaudeModel,
          send: async (request) => {
            const result = await sendClaudeMessageWithMeta({
              ...request,
              model: mapToClaudeModel(request.model || this.defaultClaudeModel)
            }, claudeAccount.accessToken);
            return normalizeAnthropicResponse(result.data);
          }
        });
      }
    }

    if (config.sources.chatgptAccount) {
      const chatAccount = pickChatGptAccount();
      if (chatAccount?.email) {
        const creds = await getCredentialsForAccount(chatAccount.email);
        if (creds?.accessToken && creds?.accountId) {
          candidates.push({
            kind: 'chatgpt-account',
            label: chatAccount.email,
            model: this.defaultChatGptModel,
            send: async (request) => sendChatGptAssistantRequest(request, creds, this.defaultChatGptModel)
          });
        }
      }
    }

    return candidates;
  }

  async resolveSource() {
    const candidates = await this.listCandidateSources();
    if (candidates.length > 0) {
      return candidates[0];
    }

    throw new Error('No assistant model source available');
  }

  async inspectStatus() {
    const config = this.getRuntimeConfig();
    const statuses = [];

    if (config.sources.chatgptAccount) {
      const chatAccount = pickChatGptAccount();
      const creds = chatAccount?.email ? await getCredentialsForAccount(chatAccount.email) : null;
      statuses.push(sourceStatusRecord({
        key: 'chatgptAccount',
        label: 'ChatGPT Account',
        enabled: true,
        available: !!(creds?.accessToken && creds?.accountId),
        detail: chatAccount?.email || 'No active ChatGPT account',
        kind: 'chatgpt-account'
      }));
    } else {
      statuses.push(sourceStatusRecord({
        key: 'chatgptAccount',
        label: 'ChatGPT Account',
        enabled: false,
        available: false,
        detail: 'Disabled',
        kind: 'chatgpt-account'
      }));
    }

    if (config.sources.claudeAccount) {
      const claudeAccount = pickClaudeAccount();
      statuses.push(sourceStatusRecord({
        key: 'claudeAccount',
        label: 'Claude Account',
        enabled: true,
        available: !!claudeAccount?.accessToken,
        detail: claudeAccount?.email || 'No usable Claude account',
        kind: 'claude-account'
      }));
    } else {
      statuses.push(sourceStatusRecord({
        key: 'claudeAccount',
        label: 'Claude Account',
        enabled: false,
        available: false,
        detail: 'Disabled',
        kind: 'claude-account'
      }));
    }

    const anthropicProvider = config.sources.anthropicApiKey ? selectKey('anthropic') : null;
    statuses.push(sourceStatusRecord({
      key: 'anthropicApiKey',
      label: 'Anthropic API Key',
      enabled: config.sources.anthropicApiKey,
      available: !!anthropicProvider,
      detail: anthropicProvider?.name || (config.sources.anthropicApiKey ? 'No available Anthropic API key' : 'Disabled'),
      kind: 'api-key'
    }));

    const openAiProvider = config.sources.openaiApiKeyBridge ? selectKey('openai') : null;
    statuses.push(sourceStatusRecord({
      key: 'openaiApiKeyBridge',
      label: 'OpenAI API Key Bridge',
      enabled: config.sources.openaiApiKeyBridge,
      available: !!openAiProvider,
      detail: openAiProvider?.name || (config.sources.openaiApiKeyBridge ? 'No available OpenAI API key' : 'Disabled'),
      kind: 'api-key'
    }));

    const azureProvider = config.sources.azureOpenaiApiKeyBridge ? selectKey('azure-openai') : null;
    statuses.push(sourceStatusRecord({
      key: 'azureOpenaiApiKeyBridge',
      label: 'Azure OpenAI Bridge',
      enabled: config.sources.azureOpenaiApiKeyBridge,
      available: !!azureProvider,
      detail: azureProvider?.name || (config.sources.azureOpenaiApiKeyBridge ? 'No available Azure OpenAI key' : 'Disabled'),
      kind: 'api-key'
    }));

    let resolvedSource = null;
    let fallbackReason = '';
    if (config.enabled) {
      try {
        const resolved = await this.resolveSource();
        resolvedSource = {
          kind: resolved.kind,
          label: resolved.label,
          model: resolved.model
        };
      } catch (error) {
        fallbackReason = error?.message || 'No assistant model source available';
      }
    } else {
      fallbackReason = 'Assistant LLM agent is disabled';
    }

    const resolvedKey = resolvedSource?.kind === 'chatgpt-account'
      ? 'chatgptAccount'
      : resolvedSource?.kind === 'claude-account'
        ? 'claudeAccount'
        : (resolvedSource?.label === openAiProvider?.name
          ? 'openaiApiKeyBridge'
          : (resolvedSource?.label === azureProvider?.name
            ? 'azureOpenaiApiKeyBridge'
            : (resolvedSource?.label === anthropicProvider?.name ? 'anthropicApiKey' : '')));

    return {
      enabled: config.enabled,
      configuredSources: config.sources,
      statuses: statuses.map((entry) => ({
        ...entry,
        selected: entry.key === resolvedKey
      })),
      resolvedSource,
      fallbackReason
    };
  }

  async complete({
    system,
    messages,
    tools = [],
    model = '',
    maxTokens = 1200
  } = {}) {
    const candidates = await this.listCandidateSources();
    if (candidates.length === 0) {
      throw new Error('No assistant model source available');
    }

    const failures = [];
    for (const source of candidates) {
      try {
        const response = await source.send({
          system,
          messages,
          tools,
          max_tokens: maxTokens,
          model: model || source.model
        });
        return {
          ...response,
          source: {
            kind: source.kind,
            label: source.label,
            model: model || source.model
          }
        };
      } catch (error) {
        failures.push(`${source.label}: ${error?.message || String(error)}`);
      }
    }

    throw new Error(`All assistant model sources failed: ${failures.join(' | ')}`);
  }
}

export const assistantLlmClient = new AssistantLlmClient();

export default assistantLlmClient;
