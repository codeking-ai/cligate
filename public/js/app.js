import { i18n } from './i18n.js';
import { createApiKeysPageModule } from './modules/api-keys-page.js';
import { createImageGenPageModule } from './modules/image-gen-page.js';
import { createAssistantTasksPageModule } from './modules/assistant-tasks-page.js';
import { createAssistantWorkbenchPageModule } from './modules/assistant-workbench-page.js';
import { createScheduledTasksPageModule } from './modules/scheduled-tasks-page.js';
import { createAccountsPageModule } from './modules/accounts-page.js';
import { createChannelsPageModule } from './modules/channels-page.js';
import { createChatPageModule } from './modules/chat-page.js';
import { createDashboardPageModule } from './modules/dashboard-page.js';
import { createLogsPageModule } from './modules/logs-page.js';
import { createSettingsPageModule } from './modules/settings-page.js';
import { createSkillsPageModule } from './modules/skills-page.js';
import { createMcpPageModule } from './modules/mcp-page.js';
import { createToolsPageModule } from './modules/tools-page.js';
import { createUsagePricingPageModule } from './modules/usage-pricing-page.js';

function composeApp(...parts) {
  const app = {};
  for (const part of parts) {
    Object.defineProperties(app, Object.getOwnPropertyDescriptors(part));
  }
  return app;
}

function createShellModule() {
  return {
    version: '1.2.1',
    connectionStatus: 'connecting',
    activeTab: 'dashboard',
    taskSubTab: 'workbench',
    viewPartialPaths: {
      dashboard: '/partials/views/dashboard.html',
      accounts: '/partials/views/accounts.html',
      chat: '/partials/views/chat.html',
      logs: '/partials/views/logs.html',
      workspaceConfig: '/partials/views/workspace-config.html',
      channels: '/partials/views/channels.html',
      assistantTasks: '/partials/views/assistant-tasks.html',
      assistantWorkbench: '/partials/views/assistant-workbench.html',
      skills: '/partials/views/skills.html',
      mcp: '/partials/views/mcp.html',
      scheduledTasks: '/partials/views/scheduled-tasks.html',
      localModels: '/partials/views/local-models.html',
      apikeys: '/partials/views/api-keys.html',
      imageGen: '/partials/views/image-gen.html',
      usage: '/partials/views/usage.html',
      pricing: '/partials/views/pricing.html',
      apiExplorer: '/partials/views/api-explorer.html',
      requestLogs: '/partials/views/request-logs.html',
      tools: '/partials/views/tools.html'
    },
    loadedViewPartials: {},
    _viewPartialPromises: {},
    isSmallScreen: window.innerWidth < 1024,
    sidebarOpen: false,
    sidebarCollapsed: localStorage.getItem('proxy-sidebar-collapsed') === 'true' && window.innerWidth >= 1024,
    navSections: {
      workspace: true,
      assistant: false,
      cliTools: false,
      credentials: false,
      configuration: false,
      observability: false
    },
    loading: false,
    toast: null,
    currentTime: '',
    lang: localStorage.getItem('proxy-lang') || 'en',
    darkMode: localStorage.getItem('proxy-theme') !== 'light',
    configPath: '~/.cligate/accounts.json',
    apiExplorerPresets: [
      { name: 'Health', method: 'GET', endpoint: '/health', body: '' },
      { name: 'Accounts', method: 'GET', endpoint: '/accounts', body: '' },
      { name: 'Claude Accounts', method: 'GET', endpoint: '/claude-accounts', body: '' },
      { name: 'Models', method: 'GET', endpoint: '/v1/models', body: '' },
      { name: 'Usage Overview', method: 'GET', endpoint: '/api/usage/overview', body: '' },
      { name: 'Request Logs', method: 'GET', endpoint: '/api/request-logs?limit=10', body: '' },
      {
        name: 'Chat Completion Test',
        method: 'POST',
        endpoint: '/v1/chat/completions',
        body: JSON.stringify({
          model: 'gpt-5.2',
          messages: [{ role: 'user', content: 'Say hello' }]
        }, null, 2)
      }
    ],
    apiExplorerPresetIndex: 0,
    apiExplorerForm: {
      method: 'GET',
      endpoint: '/health',
      body: ''
    },
    apiExplorerLoading: false,
    apiExplorerResponse: null,

    t(key, ...args) {
      const dict = i18n[this.lang] || i18n.en;
      const value = dict[key] !== undefined ? dict[key] : (i18n.en[key] || key);
      return typeof value === 'function' ? value(...args) : value;
    },

    setLang(lang) {
      this.lang = lang;
      localStorage.setItem('proxy-lang', lang);
    },

    toggleTheme() {
      this.darkMode = !this.darkMode;
      document.documentElement.classList.toggle('light', !this.darkMode);
      document.documentElement.classList.toggle('dark', this.darkMode);
      localStorage.setItem('proxy-theme', this.darkMode ? 'dark' : 'light');
    },

    loadInitialDataForTab(tab = this.activeTab) {
      this.refreshAccounts();
      this.refreshClaudeAccounts();
      this.refreshAntigravityAccounts();
      this.checkHealth();

      if (tab === 'dashboard') {
        this.refreshProxyStatus();
        this.loadHaikuModelSetting();
        this.loadKiloModels();
        return;
      }

      if (tab === 'chat') {
        this.loadChatSessions();
        this.ensureChatDependenciesLoaded();
        this.loadAgentRuntimeSessions();
        return;
      }

      if (tab === 'logs') {
        this.startLogStream();
        return;
      }

      if (tab === 'settings' || tab === 'routing') {
        this.refreshProxyStatus();
        this.loadHaikuModelSetting();
        this.loadAccountStrategySetting();
        this.loadRoutingPrioritySetting();
        this.loadRoutingModeSetting();
        this.loadAppRoutingSettings();
        this.loadFreeModelsSetting();
        this.loadKiloModels();
        return;
      }

      if (tab === 'assistantAgent') {
        this.loadAssistantAgentConfig();
        this.loadAssistantAgentStatus();
        this.loadModelMappings();
        return;
      }

      if (tab === 'localModels') {
        this.loadLocalModelRoutingSetting();
        this.loadLocalRuntimeStatus();
        return;
      }

      if (tab === 'tools') {
        this.refreshProxyStatus();
        return;
      }

      if (tab === 'assistantTasks') {
        this.loadAssistantTasks();
        return;
      }

      if (tab === 'assistantWorkbench') {
        this.loadAssistantWorkbench();
        return;
      }

      if (tab === 'scheduledTasks') {
        this.loadScheduledTasks();
      }
    },

    ensureChatDependenciesLoaded() {
      if (!Array.isArray(this.chatSources) || this.chatSources.length === 0) {
        this.loadChatSources();
      }
      if (!Array.isArray(this.chatModels) || this.chatModels.length === 0) {
        this.loadChatModels();
      }
      if (!Array.isArray(this.agentRuntimeProviders) || this.agentRuntimeProviders.length === 0) {
        this.loadAgentRuntimeProviders();
      }
    },

    init() {
      document.documentElement.classList.toggle('light', !this.darkMode);
      document.documentElement.classList.toggle('dark', this.darkMode);
      queueMicrotask(() => {
        this.ensureViewPartialLoadedForTab(this.activeTab);
      });
      this.loadNavSections();
      this.syncResponsiveLayout();
      this.ensureActiveNavSection();
      this.updateTime();
      setInterval(() => this.updateTime(), 1000);
      this.loadInitialDataForTab(this.activeTab);
      setInterval(() => this.checkHealth(), 30000);
      setInterval(() => {
        if (this.activeTab === 'chat') {
          this.loadAgentRuntimeSessions();
        }
      }, 15000);
      setInterval(() => {
        if (this.activeTab === 'chat' && this.chatHistoryOpen) {
          this.loadChannelConversations({ silent: true });
        }
      }, 5000);
      // Poll the active chat session so background-pushed messages
      // (scheduled-task notifications, async assistant runs) surface in the
      // open conversation without requiring the user to re-click their session.
      setInterval(() => {
        if (this.activeTab !== 'chat') return;
        if (!this.activeChatSessionId) return;
        if (typeof this.refreshChatSessionFromServer !== 'function') return;
        this.refreshChatSessionFromServer(this.activeChatSessionId);
      }, 8000);
      setInterval(() => {
        if (this.activeTab === 'assistantTasks') {
          this.loadAssistantTasks({ silent: true });
          if (this.selectedAssistantTaskId) {
            this.loadAssistantTaskDetail(this.selectedAssistantTaskId, { silent: true });
          }
        }
      }, 5000);
      this.initConfigViewerFromUrl();

      window.addEventListener('resize', () => {
        this.syncResponsiveLayout();
      });

      window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'oauth-success') {
          this.showToast(`Account ${event.data.email} added!`, 'success');
          this.showAddModal = false;
          this.refreshAccounts();
        }
        if (event.data && event.data.type === 'claude-oauth-success') {
          this.showToast('Claude account added!', 'success');
          this.refreshClaudeAccounts();
        }
        if (event.data && event.data.type === 'antigravity-oauth-success') {
          this.showToast(this.t('antigravityAccountAdded'), 'success');
          this.refreshAntigravityAccounts();
        }
      });
    },

    updateTime() {
      this.currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },

    loadNavSections() {
      try {
        const saved = JSON.parse(localStorage.getItem('proxy-nav-sections') || '{}');
        this.navSections = {
          workspace: saved.workspace !== undefined ? !!saved.workspace : (saved.main !== undefined ? !!saved.main : true),
          assistant: saved.assistant !== undefined ? !!saved.assistant : false,
          cliTools: saved.cliTools !== undefined ? !!saved.cliTools : false,
          credentials: saved.credentials !== undefined ? !!saved.credentials : false,
          channels: saved.channels !== undefined ? !!saved.channels : false,
          configuration: saved.configuration !== undefined ? !!saved.configuration : (saved.system !== undefined ? !!saved.system : false),
          resources: saved.resources !== undefined ? !!saved.resources : false,
          observability: saved.observability !== undefined ? !!saved.observability : (saved.api !== undefined ? !!saved.api : false)
        };
      } catch {
        this.navSections = { workspace: true, assistant: false, cliTools: false, credentials: false, channels: false, configuration: false, observability: false, resources: false };
      }
    },

    saveNavSections() {
      localStorage.setItem('proxy-nav-sections', JSON.stringify(this.navSections));
    },

    sectionForTab(tab) {
      if (['dashboard', 'chat', 'tasks', 'assistantTasks', 'assistantWorkbench', 'scheduledTasks'].includes(tab)) return 'workspace';
      if (['assistantAgent', 'skills', 'mcp'].includes(tab)) return 'assistant';
      if (['tools'].includes(tab)) return 'cliTools';
      if (['accounts', 'apikeys', 'localModels'].includes(tab)) return 'credentials';
      if (['channels'].includes(tab)) return 'channels';
      if (['settings', 'routing'].includes(tab)) return 'configuration';
      if (['resources', 'manual'].includes(tab)) return 'resources';
      if (['usage', 'pricing', 'apiExplorer', 'requestLogs', 'logs'].includes(tab)) return 'observability';
      return 'workspace';
    },

    isSectionExpanded(section) {
      return this.sidebarCollapsed || !!this.navSections[section];
    },

    toggleNavSection(section) {
      this.navSections[section] = !this.navSections[section];
      this.saveNavSections();
    },

    ensureActiveNavSection() {
      const section = this.sectionForTab(this.activeTab);
      if (!this.navSections[section]) {
        this.navSections[section] = true;
        this.saveNavSections();
      }
    },

    syncResponsiveLayout() {
      this.isSmallScreen = window.innerWidth < 1024;
      if (this.isSmallScreen) {
        this.sidebarOpen = false;
        return;
      }
      this.sidebarOpen = false;
      this.sidebarCollapsed = localStorage.getItem('proxy-sidebar-collapsed') === 'true';
    },

    toggleSidebar() {
      if (this.isSmallScreen) {
        this.sidebarOpen = !this.sidebarOpen;
        return;
      }
      this.sidebarCollapsed = !this.sidebarCollapsed;
      localStorage.setItem('proxy-sidebar-collapsed', this.sidebarCollapsed);
    },

    setActiveTab(tab) {
      this.activeTab = tab;
      this.ensureViewPartialLoadedForTab(tab);
      this.ensureActiveNavSection();
      if (this.isSmallScreen) {
        this.sidebarOpen = false;
      }
      if (tab === 'accounts') {
        this.refreshAccounts();
        this.refreshClaudeAccounts();
        this.refreshAntigravityAccounts();
      }
      if (tab === 'apikeys') this.loadApiKeys();
      if (tab === 'imageGen') this.loadImageGenStatus();
      if (tab === 'usage') this.loadUsageData();
      if (tab === 'pricing') this.loadPricingData();
      if (tab === 'apiExplorer' && !this.apiExplorerResponse) this.loadApiExplorerPreset(this.apiExplorerPresetIndex);
      if (tab === 'dashboard') this.refreshProxyStatus();
      if (tab === 'logs') {
        this.startLogStream();
      } else if (this.logEventSource || this.logStreamReconnectTimer) {
        this.stopLogStream();
      }
      if (tab === 'localModels') this.loadLocalRuntimeStatus();
      if (tab === 'chat') {
        // Initialize chat sessions from localStorage (and auto-create one when
        // none exist) the first time the chat tab is shown. loadInitialDataForTab
        // only does this when chat is the *initial* tab; navigating here from
        // another tab via setActiveTab used to skip it, leaving chatSessions=[]
        // and activeChatSessionId='' — so getActiveChatSession() returned null
        // and sendChatMessage()/Ctrl+Enter silently no-op'd until the user
        // manually clicked "新建对话". Guarded so revisiting chat keeps the
        // currently-open session instead of resetting to the most recent one.
        if (!Array.isArray(this.chatSessions) || this.chatSessions.length === 0 || !this.activeChatSessionId) {
          this.loadChatSessions();
        }
        this.ensureChatDependenciesLoaded();
        this.loadAgentRuntimeSessions();
        if (typeof this.loadChannelConversations === 'function') {
          this.loadChannelConversations({ silent: true });
        }
      }
      if (tab === 'channels') {
        this.loadChannelProviders();
        this.loadChannelCatalog();
        this.loadChannelSettings();
      }
      if (tab === 'assistantTasks') {
        this.loadAssistantTasks().then(() => {
          if (this.selectedAssistantTaskId) {
            this.loadAssistantTaskDetail(this.selectedAssistantTaskId, { silent: true });
          }
        });
      }
      if (tab === 'skills') {
        this.loadSkills();
      }
      if (tab === 'mcp') {
        this.loadMcpServers();
      }
      if (tab === 'assistantWorkbench') {
        this.loadAssistantWorkbench();
      }
      if (tab === 'scheduledTasks') {
        this.loadScheduledTasks();
      }
      if (tab === 'tasks') {
        this.loadTaskSubTabData(this.taskSubTab);
      }
      if (tab === 'settings') {
        this.refreshProxyStatus();
      }
      if (tab === 'assistantAgent') {
        if (!this.modelMappingData) this.loadModelMappings();
        this.loadAssistantAgentConfig();
        this.loadAssistantAgentStatus();
      }
      if (tab === 'routing') {
        this.loadHaikuModelSetting();
        this.loadAccountStrategySetting();
        this.loadRoutingPrioritySetting();
        this.loadRoutingModeSetting();
        this.loadAppRoutingSettings();
        this.loadFreeModelsSetting();
        if (!this.modelMappingData) this.loadModelMappings();
      }
      if (tab === 'localModels') {
        this.loadLocalModelRoutingSetting();
      }
    },

    loadApiExplorerPreset(index) {
      const preset = this.apiExplorerPresets[index];
      if (!preset) return;
      this.apiExplorerPresetIndex = index;
      this.apiExplorerForm = {
        method: preset.method,
        endpoint: preset.endpoint,
        body: preset.body || ''
      };
    },

    apiExplorerCanSendBody() {
      return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(this.apiExplorerForm.method);
    },

    clearApiExplorerResponse() {
      this.apiExplorerResponse = null;
    },

    async copyApiExplorerResponse() {
      if (!this.apiExplorerResponse?.bodyText) return;
      try {
        await navigator.clipboard.writeText(this.apiExplorerResponse.bodyText);
        this.showToast(this.t('copiedToClipboard'), 'success');
      } catch {
        this.showToast(this.t('failedToCopy'), 'error');
      }
    },

    async runApiExplorerRequest() {
      const endpoint = this.apiExplorerForm.endpoint.trim();
      if (!endpoint) {
        this.showToast(this.t('endpointRequired'), 'error');
        return;
      }

      const method = this.apiExplorerForm.method.toUpperCase();
      const headers = { Accept: 'application/json' };
      const options = { method, headers };

      if (this.apiExplorerCanSendBody()) {
        const body = this.apiExplorerForm.body.trim();
        if (body) {
          try {
            JSON.parse(body);
            headers['Content-Type'] = 'application/json';
            options.body = body;
          } catch {
            this.showToast(this.t('invalidJsonBody'), 'error');
            return;
          }
        }
      }

      this.apiExplorerLoading = true;
      const startedAt = performance.now();

      try {
        const response = await fetch(endpoint, options);
        const durationMs = Math.round(performance.now() - startedAt);
        const rawText = await response.text();
        let parsedBody = null;
        let prettyBody = rawText;

        try {
          parsedBody = rawText ? JSON.parse(rawText) : null;
          prettyBody = parsedBody === null ? '' : JSON.stringify(parsedBody, null, 2);
        } catch {
          parsedBody = null;
        }

        this.apiExplorerResponse = {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          durationMs,
          contentType: response.headers.get('content-type') || '-',
          headers: Array.from(response.headers.entries()),
          isJson: parsedBody !== null,
          body: parsedBody,
          bodyText: rawText,
          prettyBody
        };
      } catch (error) {
        this.apiExplorerResponse = {
          ok: false,
          status: 0,
          statusText: 'NETWORK_ERROR',
          durationMs: Math.round(performance.now() - startedAt),
          contentType: '-',
          headers: [],
          isJson: false,
          body: null,
          bodyText: error.message,
          prettyBody: error.message
        };
        this.showToast(error.message || this.t('requestFailed'), 'error');
      } finally {
        this.apiExplorerLoading = false;
      }
    },

    async api(endpoint, options = {}) {
      try {
        const response = await fetch(endpoint, {
          headers: { 'Content-Type': 'application/json' },
          ...options
        });
        const data = await response.json();
        return { ok: response.ok, data };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    async checkHealth() {
      const { ok } = await this.api('/health');
      this.connectionStatus = ok ? 'connected' : 'disconnected';
    },

    viewPartialKeyForTab(tab) {
      if (['settings', 'assistantAgent', 'routing'].includes(tab)) return 'workspaceConfig';
      if (tab === 'tasks') {
        if (this.taskSubTab === 'workbench') return 'assistantWorkbench';
        if (this.taskSubTab === 'scheduled') return 'scheduledTasks';
        return 'assistantTasks';
      }
      return tab;
    },

    switchTaskSubTab(subTab) {
      this.taskSubTab = subTab;
      this.ensureViewPartialLoadedForTab('tasks');
      this.loadTaskSubTabData(subTab);
    },

    loadTaskSubTabData(subTab) {
      if (subTab === 'active') {
        if (typeof this.loadAssistantTasks === 'function') {
          this.loadAssistantTasks().then(() => {
            if (this.selectedAssistantTaskId && typeof this.loadAssistantTaskDetail === 'function') {
              this.loadAssistantTaskDetail(this.selectedAssistantTaskId, { silent: true });
            }
          });
        }
      } else if (subTab === 'workbench') {
        if (typeof this.loadAssistantWorkbench === 'function') {
          this.loadAssistantWorkbench();
        }
      } else if (subTab === 'scheduled') {
        if (typeof this.loadScheduledTasks === 'function') {
          this.loadScheduledTasks();
        }
      }
    },

    ensureViewPartialLoadedForTab(tab) {
      return this.ensureViewPartialLoaded(this.viewPartialKeyForTab(tab));
    },

    getViewPartialHost(viewKey) {
      return document.querySelector(`[data-partial-view="${viewKey}"]`);
    },

    escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;'
      }[char]));
    },

    async ensureViewPartialLoaded(viewKey) {
      const partialPath = this.viewPartialPaths[viewKey];
      if (!partialPath || this.loadedViewPartials[viewKey]) return;

      const host = this.getViewPartialHost(viewKey);
      if (!host) return;

      if (this._viewPartialPromises[viewKey]) {
        return this._viewPartialPromises[viewKey];
      }

      this._viewPartialPromises[viewKey] = (async () => {
        try {
          const response = await fetch(`${partialPath}?v=20260511-dashboard-partial-1`, {
            cache: 'no-cache'
          });

          if (!response.ok) {
            throw new Error(`Failed to load ${viewKey} view (${response.status})`);
          }

          host.innerHTML = await response.text();
          this.loadedViewPartials = {
            ...this.loadedViewPartials,
            [viewKey]: true
          };

          if (window.Alpine?.initTree) {
            window.Alpine.initTree(host);
          }
        } catch (error) {
          host.innerHTML = `
            <div class="view-card border border-red-500/30">
              <div class="text-sm text-red-400 font-mono">${this.escapeHtml(error.message || `Failed to load ${viewKey} view`)}</div>
            </div>
          `;
          this.showToast(error.message || `Failed to load ${viewKey} view`, 'error');
        } finally {
          delete this._viewPartialPromises[viewKey];
        }
      })();

      return this._viewPartialPromises[viewKey];
    },

    showToast(message, type = 'success') {
      this.toast = { message, type };
      setTimeout(() => {
        this.toast = null;
      }, 3000);
    }
  };
}

function registerApp() {
  if (!window.Alpine) return;
  Alpine.data('app', () => composeApp(
    createShellModule(),
    createDashboardPageModule(),
    createAccountsPageModule(),
    createChatPageModule(),
    createAssistantTasksPageModule(),
    createAssistantWorkbenchPageModule(),
    createScheduledTasksPageModule(),
    createSettingsPageModule(),
    createSkillsPageModule(),
    createMcpPageModule(),
    createLogsPageModule(),
    createUsagePricingPageModule(),
    createToolsPageModule(),
    createApiKeysPageModule(),
    createImageGenPageModule(),
    createChannelsPageModule()
  ));
}

let appRegistered = false;

function registerAppOnce() {
  if (appRegistered) return;
  registerApp();
  appRegistered = true;
}

document.addEventListener('alpine:init', registerAppOnce, { once: true });

if (window.Alpine) {
  registerAppOnce();
}
