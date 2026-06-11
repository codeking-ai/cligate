import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

function loadCreateShellModule() {
  const source = readFileSync(join(process.cwd(), 'public', 'js', 'app.js'), 'utf8');
  const start = source.indexOf('function createShellModule() {');
  const end = source.indexOf('\nfunction registerApp() {');
  assert.notEqual(start, -1, 'createShellModule not found');
  assert.notEqual(end, -1, 'registerApp boundary not found');
  const snippet = `${source.slice(start, end)}\nmodule.exports = { createShellModule };`;
  const context = {
    module: { exports: {} },
    exports: {},
    window: {
      innerWidth: 1280,
      addEventListener() {}
    },
    document: {
      documentElement: {
        classList: {
          toggle() {}
        }
      }
    },
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {}
    },
    queueMicrotask(fn) {
      fn();
    },
    setInterval() {
      return 0;
    },
    clearInterval() {},
    URLSearchParams,
    URL,
    fetch: async () => ({ ok: false, json: async () => ({}) })
  };
  vm.runInNewContext(snippet, context, { filename: 'public/js/app.js' });
  return context.module.exports.createShellModule;
}

function createShellHarness(overrides = {}) {
  const createShellModule = loadCreateShellModule();
  return {
    ...createShellModule(),
    ensureViewPartialLoadedForTab() {},
    loadNavSections() {},
    syncResponsiveLayout() {},
    ensureActiveNavSection() {},
    updateTime() {},
    initConfigViewerFromUrl() {},
    showToast() {},
    ...overrides
  };
}

test('shell init on dashboard skips eager chat and assistant dependency loads', () => {
  const calls = [];
  const app = createShellHarness({
    activeTab: 'dashboard',
    refreshAccounts() { calls.push('refreshAccounts'); },
    refreshClaudeAccounts() { calls.push('refreshClaudeAccounts'); },
    refreshAntigravityAccounts() { calls.push('refreshAntigravityAccounts'); },
    checkHealth() { calls.push('checkHealth'); },
    refreshProxyStatus() { calls.push('refreshProxyStatus'); },
    loadHaikuModelSetting() { calls.push('loadHaikuModelSetting'); },
    loadKiloModels() { calls.push('loadKiloModels'); },
    loadChatSessions() { calls.push('loadChatSessions'); },
    loadChatSources() { calls.push('loadChatSources'); },
    loadChatModels() { calls.push('loadChatModels'); },
    loadAgentRuntimeProviders() { calls.push('loadAgentRuntimeProviders'); },
    loadAgentRuntimeSessions() { calls.push('loadAgentRuntimeSessions'); },
    loadAssistantAgentConfig() { calls.push('loadAssistantAgentConfig'); },
    startLogStream() { calls.push('startLogStream'); }
  });

  app.init();

  assert.deepEqual(calls, [
    'refreshAccounts',
    'refreshClaudeAccounts',
    'refreshAntigravityAccounts',
    'checkHealth',
    'refreshProxyStatus',
    'loadHaikuModelSetting',
    'loadKiloModels'
  ]);
});

test('shell init on chat eagerly loads chat dependencies and runtime sessions', () => {
  const calls = [];
  const app = createShellHarness({
    activeTab: 'chat',
    refreshAccounts() { calls.push('refreshAccounts'); },
    refreshClaudeAccounts() { calls.push('refreshClaudeAccounts'); },
    refreshAntigravityAccounts() { calls.push('refreshAntigravityAccounts'); },
    checkHealth() { calls.push('checkHealth'); },
    loadChatSessions() { calls.push('loadChatSessions'); },
    loadChatSources() { calls.push('loadChatSources'); this.chatSources = [{ id: 'source-1' }]; },
    loadChatModels() { calls.push('loadChatModels'); this.chatModels = ['gpt-5.2']; },
    loadAgentRuntimeProviders() { calls.push('loadAgentRuntimeProviders'); this.agentRuntimeProviders = [{ id: 'codex' }]; },
    loadAgentRuntimeSessions() { calls.push('loadAgentRuntimeSessions'); }
  });

  app.init();

  assert.deepEqual(calls, [
    'refreshAccounts',
    'refreshClaudeAccounts',
    'refreshAntigravityAccounts',
    'checkHealth',
    'loadChatSessions',
    'loadChatSources',
    'loadChatModels',
    'loadAgentRuntimeProviders',
    'loadAgentRuntimeSessions'
  ]);
});

test('setActiveTab chat only reloads missing chat dependencies', () => {
  const calls = [];
  const app = createShellHarness({
    chatSources: [{ id: 'source-1' }],
    chatModels: ['gpt-5.2'],
    agentRuntimeProviders: [{ id: 'codex' }],
    loadChatSources() { calls.push('loadChatSources'); },
    loadChatModels() { calls.push('loadChatModels'); },
    loadAgentRuntimeProviders() { calls.push('loadAgentRuntimeProviders'); },
    loadAgentRuntimeSessions() { calls.push('loadAgentRuntimeSessions'); },
    loadChannelConversations(options) { calls.push(['loadChannelConversations', options]); }
  });

  app.setActiveTab('chat');

  assert.equal(calls.length, 2);
  assert.equal(calls[0], 'loadAgentRuntimeSessions');
  assert.equal(calls[1][0], 'loadChannelConversations');
  assert.equal(calls[1][1].silent, true);
});
