export function createChatPageModule() {
  return {
    chatAssistantRunPoller: null,
    chatSources: [],
    chatModels: [],
    chatSourceId: '',
    chatModel: 'gpt-5.2',
    chatSystemPrompt: '',
    chatInput: '',
    chatPendingImage: null,
    chatMessages: [],
    chatSessions: [],
    activeChatSessionId: '',
    chatStorageKey: 'cligate-chat-sessions-v1',
    chatHistoryOpen: false,
    chatSystemPromptOpen: false,
    chatMode: 'assistant',
    chatAssistantMode: true,
    agentRuntimeProviders: [],
    agentRuntimeSessions: [],
    agentRuntimeSessionsLoading: false,
    agentRuntimeCollapsedCwds: {},
    assistantMind: {
      pendingClarification: null,
      pendingQuestions: [],
      pendingApprovals: [],
      knownCwds: [],
      recentTasks: [],
      relevantArtifacts: [],
      recentChatTurns: []
    },
    assistantMindSummary: {
      knownCwdCount: 0
    },
    assistantMindLoading: false,
    assistantAliasEditingFor: '',
    assistantAliasInput: '',
    chatRuntimeProvider: 'codex',
    chatRuntimeEventSource: null,
    chatAssistantRunEventSource: null,
    chatAssistantRunEvents: {},
    chatAssistantRunLastSeq: {},
    chatAssistantRunTraceOpen: {},
    chatLoading: false,
    chatSourceLoading: false,
    chatStreamController: null,
    chatHistoryChannelFilter: 'all',
    chatSourceHealth: {},

    classifyChatError(status, text) {
      const code = Number(status) || 0;
      const lower = String(text || '').toLowerCase();
      const baseRaw = String(text || '').slice(0, 600);
      if (code === 401 || code === 403 || lower.includes('unauthor') || lower.includes('api key') || lower.includes('invalid token')) {
        return {
          status: code || 401,
          category: 'auth',
          message: this.t('chatErrorAuthMessage'),
          raw: baseRaw,
          jumpTo: { tab: 'apikeys', label: this.t('chatErrorJumpKeys') }
        };
      }
      if (code === 429 || lower.includes('rate limit') || lower.includes('quota') || lower.includes('exceeded')) {
        return {
          status: code || 429,
          category: 'quota',
          message: this.t('chatErrorQuotaMessage'),
          raw: baseRaw,
          jumpTo: { tab: 'usage', label: this.t('chatErrorJumpUsage') }
        };
      }
      if (code === 404 || (lower.includes('model') && (lower.includes('not found') || lower.includes('unknown') || lower.includes('does not exist')))) {
        return {
          status: code || 404,
          category: 'model_not_found',
          message: this.t('chatErrorModelMessage'),
          raw: baseRaw,
          jumpTo: { tab: 'routing', label: this.t('chatErrorJumpRouting') }
        };
      }
      if (code === 408 || code === 504 || lower.includes('timeout') || lower.includes('timed out')) {
        return {
          status: code || 408,
          category: 'timeout',
          message: this.t('chatErrorTimeoutMessage'),
          raw: baseRaw,
          jumpTo: null
        };
      }
      if (code === 0 || lower.includes('failed to fetch') || lower.includes('network')) {
        return {
          status: 0,
          category: 'network',
          message: this.t('chatErrorNetworkMessage'),
          raw: baseRaw,
          jumpTo: null
        };
      }
      return {
        status: code || 500,
        category: 'unknown',
        message: text ? baseRaw : this.t('chatErrorUnknownMessage'),
        raw: baseRaw,
        jumpTo: { tab: 'accounts', label: this.t('chatErrorJumpAccounts') }
      };
    },

    recordChatSourceHealth(sourceId, latencyMs, success) {
      const key = String(sourceId || '').trim();
      if (!key) return;
      const entry = {
        timestamp: Date.now(),
        latency: Math.max(0, Number(latencyMs) || 0),
        success: success === true
      };
      const buffer = Array.isArray(this.chatSourceHealth[key]) ? this.chatSourceHealth[key] : [];
      buffer.push(entry);
      while (buffer.length > 20) buffer.shift();
      this.chatSourceHealth = { ...this.chatSourceHealth, [key]: buffer };
    },

    chatSourceHealthStats(sourceId) {
      const key = String(sourceId || '').trim();
      const buffer = Array.isArray(this.chatSourceHealth[key]) ? this.chatSourceHealth[key] : [];
      if (buffer.length === 0) return null;
      const successes = buffer.filter((e) => e.success).length;
      const latencies = buffer.filter((e) => e.success).map((e) => e.latency).sort((a, b) => a - b);
      const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : 0;
      return {
        total: buffer.length,
        successes,
        successRate: Math.round((successes / buffer.length) * 100),
        p50
      };
    },

    chatSourceHealthClass(sourceId) {
      const stats = this.chatSourceHealthStats(sourceId);
      if (!stats) return 'text-gray-400 border-space-border/40 bg-space-800/60';
      if (stats.successRate >= 90) return 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10';
      if (stats.successRate >= 60) return 'text-amber-300 border-amber-500/30 bg-amber-500/10';
      return 'text-red-300 border-red-500/30 bg-red-500/10';
    },


    chatHistoryChannelLabel(channel) {
      const value = String(channel || '').toLowerCase();
      const map = {
        web: 'Web',
        dingtalk: '钉钉',
        wechat: '微信',
        wechat_kf: '微信客服',
        wecom: '企业微信',
        slack: 'Slack',
        whatsapp: 'WhatsApp',
        feishu: '飞书',
        lark: 'Lark',
        telegram: 'Telegram',
        email: 'Email'
      };
      return map[value] || (value ? value.charAt(0).toUpperCase() + value.slice(1) : '-');
    },

    chatHistoryChannelBadgeClass(channel) {
      const value = String(channel || '').toLowerCase();
      const map = {
        web: 'text-cyan-300 border-cyan-500/30 bg-cyan-500/10',
        dingtalk: 'text-blue-300 border-blue-500/30 bg-blue-500/10',
        wechat: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
        wechat_kf: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
        wecom: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
        slack: 'text-violet-300 border-violet-500/30 bg-violet-500/10',
        whatsapp: 'text-green-300 border-green-500/30 bg-green-500/10',
        feishu: 'text-orange-300 border-orange-500/30 bg-orange-500/10',
        lark: 'text-orange-300 border-orange-500/30 bg-orange-500/10',
        telegram: 'text-sky-300 border-sky-500/30 bg-sky-500/10',
        email: 'text-amber-300 border-amber-500/30 bg-amber-500/10'
      };
      return map[value] || 'text-gray-300 border-space-border/40 bg-space-800/60';
    },

    // Channels that must never appear as REMOTE history cards: `chat-ui`/`web`
    // are the local Web chats themselves (already shown as local cards), and
    // any `*-scope` (e.g. `scheduled-task-scope`) is an internal conversation
    // scope, not a user-facing channel.
    isHiddenHistoryChannel(channel) {
      const value = String(channel || '').toLowerCase();
      if (!value) return false;
      return value === 'chat-ui' || value === 'web' || value.endsWith('-scope');
    },

    unifiedChatHistory() {
      const filter = String(this.chatHistoryChannelFilter || 'all');
      const localItems = (this.chatSessions || []).map((session) => {
        const messages = Array.isArray(session.messages) ? session.messages : [];
        const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
        const preview = lastMsg ? String(lastMsg.content || '').slice(0, 120) : '';
        const modeLabel = session.mode === 'direct-chat'
          ? this.t('chatModeAssistant')
          : this.t('chatModeAgent');
        const subtitleParts = [modeLabel];
        if (session.model) subtitleParts.push(session.model);
        return {
          id: 'local:' + session.id,
          type: 'local',
          channel: 'web',
          title: this.chatSessionTitle ? this.chatSessionTitle(session) : (session.title || this.t('newChat')),
          subtitle: subtitleParts.join(' · '),
          preview,
          badgeUnread: session.runtimeUnread === true,
          updatedAt: session.updatedAt || new Date(0).toISOString(),
          raw: session
        };
      });

      // Web Chat conversations live on the `chat-ui` channel server-side, so
      // /api/agent-channels/conversations returns them alongside true external
      // channels — but they are ALREADY shown as local session cards (channel
      // 'web'). Listing them again as "Chat UI / chat_xxx" remote cards was the
      // bulk of the history duplication (7 local + 44 remote = 51 cards, where
      // ~29 remote were chat-ui echoes of local chats). `scheduled-task-scope`
      // (and any other internal *-scope) is not a user conversation at all.
      // Drop both here, and dedupe a remote channel already opened as a local
      // shadow session (originConversationId) — that was the telegram double card.
      const localConversationIds = new Set(
        (this.chatSessions || [])
          .map((session) => String(session.originConversationId || '').trim())
          .filter(Boolean)
      );
      const seenRemoteConversationIds = new Set();
      const remoteItems = (this.channelConversations || [])
        .filter((conv) => {
          const channel = String(conv.channel || conv.provider || '').toLowerCase();
          if (this.isHiddenHistoryChannel(channel)) return false;
          const conversationId = String(conv.conversationId || conv.id || '').trim();
          if (conversationId && localConversationIds.has(conversationId)) return false;
          if (conversationId && seenRemoteConversationIds.has(conversationId)) return false;
          if (conversationId) seenRemoteConversationIds.add(conversationId);
          return true;
        })
        .map((conv) => {
          const channel = String(conv.channel || conv.provider || 'unknown').toLowerCase();
          const subtitleParts = [conv.provider, conv.channel].filter(Boolean);
          return {
            id: 'remote:' + conv.id,
            type: 'remote',
            channel,
            title: conv.title || conv.externalConversationId || conv.id || '-',
            subtitle: subtitleParts.join(' · '),
            preview: conv.lastMessagePreview || conv.summary || '',
            badgeUnread: false,
            updatedAt: conv.lastMessageAt || conv.updatedAt || new Date(0).toISOString(),
            raw: conv
          };
        });

      const all = [...localItems, ...remoteItems];
      const filtered = filter === 'all' ? all : all.filter((card) => card.channel === filter);
      filtered.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      return filtered;
    },

    chatHistoryChannelOptions() {
      const seen = new Set();
      const opts = [];
      const push = (id) => {
        const value = String(id || '').toLowerCase();
        if (!value || seen.has(value)) return;
        seen.add(value);
        opts.push({ id: value, label: this.chatHistoryChannelLabel(value) });
      };
      push('web');
      for (const conv of (this.channelConversations || [])) {
        const channel = String(conv.channel || '').toLowerCase();
        if (this.isHiddenHistoryChannel(channel)) continue;
        push(conv.channel);
      }
      return opts;
    },

    activeSessionOriginChannel() {
      const session = this.getActiveChatSession ? this.getActiveChatSession() : null;
      return session?.originChannel || '';
    },

    async openRemoteConversation(remoteCard, options = {}) {
      if (!remoteCard || remoteCard.type !== 'remote') return;
      const conv = remoteCard.raw;
      const conversationId = String(conv?.conversationId || conv?.id || '').trim();
      if (!conversationId) return;
      const shadowSessionId = 'chat_remote_' + conversationId;
      const channel = String(conv.channel || conv.provider || '').toLowerCase();

      let deliveries = [];
      let fetchOk = false;
      try {
        const { ok, data } = await this.api('/api/agent-channels/conversations/' + encodeURIComponent(conversationId));
        fetchOk = ok === true;
        const list = Array.isArray(data?.conversation?.deliveries) ? data.conversation.deliveries
          : (Array.isArray(data?.deliveries) ? data.deliveries : []);
        if (fetchOk) deliveries = list;
      } catch (err) {
        fetchOk = false;
      }

      if (!fetchOk && typeof this.showToast === 'function') {
        this.showToast(this.t('chatHistoryLoadFailed'), 'error');
      }

      const remoteMsgs = deliveries.map((record) => {
        const payload = record.payload || {};
        const isInbound = record.direction === 'inbound';
        return {
          role: isInbound ? 'user' : 'assistant',
          content: isInbound
            ? (payload.text || '')
            : (payload.fullText || payload.text || payload.summary || ''),
          _origin: 'remote',
          _originId: record.id,
          _originChannel: channel,
          _originTimestamp: record.updatedAt || record.createdAt || '',
          isError: record.status === 'failed'
        };
      });

      const existing = this.chatSessions.find((s) => s.id === shadowSessionId);
      const webMsgs = existing && Array.isArray(existing.messages)
        ? existing.messages.filter((m) => m._origin === 'web')
        : [];

      const messages = fetchOk
        ? [...remoteMsgs, ...webMsgs]
        : (existing?.messages || []);

      const session = {
        id: shadowSessionId,
        title: conv.title || conv.externalConversationId || conversationId,
        mode: 'agent-runtime',
        sourceId: existing?.sourceId || '',
        runtimeProvider: existing?.runtimeProvider || this.chatRuntimeProvider || 'codex',
        runtimeSessionId: existing?.runtimeSessionId || '',
        attachedRuntimeProvider: existing?.attachedRuntimeProvider || '',
        attachedRuntimeModel: existing?.attachedRuntimeModel || '',
        runtimeStatus: existing?.runtimeStatus || '',
        runtimeLastEventSeq: Number(existing?.runtimeLastEventSeq || 0),
        runtimePendingQuestion: existing?.runtimePendingQuestion || null,
        runtimePendingApprovals: Array.isArray(existing?.runtimePendingApprovals)
          ? existing.runtimePendingApprovals
          : [],
        runtimeUnread: false,
        model: existing?.model || '',
        assistantMode: this.chatAssistantMode === true,
        systemPrompt: existing?.systemPrompt || '',
        messages,
        originChannel: channel,
        originProvider: conv.provider || '',
        originConversationId: conversationId,
        originRuntimeSessionId: conv.runtimeSessionId || '',
        originExternalId: conv.externalConversationId || '',
        originTitle: conv.title || '',
        updatedAt: new Date().toISOString()
      };

      const idx = this.chatSessions.findIndex((s) => s.id === shadowSessionId);
      if (idx >= 0) {
        this.chatSessions[idx] = session;
      } else {
        this.chatSessions.unshift(session);
      }
      this.persistChatSessions();
      this.openChatSession(shadowSessionId);
      if (!options.keepDrawerOpen && window.innerWidth < 1280) {
        this.chatHistoryOpen = false;
      }
    },

    async refreshActiveRemoteConversation() {
      const session = this.getActiveChatSession ? this.getActiveChatSession() : null;
      if (!session?.originConversationId) return;
      const remoteConv = (this.channelConversations || []).find(
        (c) => c.id === session.originConversationId
      ) || {
        id: session.originConversationId,
        channel: session.originChannel,
        provider: session.originProvider,
        title: session.originTitle,
        externalConversationId: session.originExternalId
      };
      await this.openRemoteConversation({ type: 'remote', raw: remoteConv }, { keepDrawerOpen: true });
    },

    async loadChatSources() {
      this.chatSourceLoading = true;
      const { ok, data } = await this.api('/api/chat/sources');
      if (ok && Array.isArray(data?.sources)) {
        this.chatSources = data.sources;
        if (!this.chatSourceId || !this.chatSources.some((source) => source.id === this.chatSourceId)) {
          this.chatSourceId = this.chatSources[0]?.id || '';
        }
        this.ensureChatModelMatchesSource();
        this.syncActiveChatSession();
      }
      this.chatSourceLoading = false;
    },

    async loadChatModels() {
      const { ok, data } = await this.api('/v1/models');
      if (ok && Array.isArray(data?.data)) {
        this.chatModels = data.data.map((item) => item.id).filter(Boolean);
        this.ensureChatModelMatchesSource();
      }
    },

    chatSourceById(sourceId = this.chatSourceId) {
      return this.chatSources.find((source) => source.id === sourceId) || null;
    },

    inferProviderTypeForModel(modelId) {
      const value = String(modelId || '').trim().toLowerCase();
      if (!value) return null;
      if (value.startsWith('claude-')) return 'anthropic';
      if (value.startsWith('gemini-')) return 'gemini';
      if (value.startsWith('deepseek-') || value === 'deepseek-chat' || value === 'deepseek-reasoner') return 'deepseek';
      if (value.startsWith('gpt-') || /^o[134](-|$)/.test(value) || value.includes('codex')) return 'openai';
      return null;
    },

    providerTypeForChatSource(sourceId = this.chatSourceId) {
      const source = this.chatSourceById(sourceId);
      if (!source) return null;
      if (source.kind === 'chatgpt-account') return 'openai';
      if (source.kind === 'claude-account') return 'anthropic';
      if (source.kind === 'api-key') {
        return this.normalizeModelMappingProvider(source.meta?.providerType || '');
      }
      return null;
    },

    modelsForChatSource(sourceId = this.chatSourceId) {
      const source = this.chatSourceById(sourceId);
      const sourceModels = Array.isArray(source?.meta?.models) ? source.meta.models.filter(Boolean) : [];
      if (sourceModels.length > 0) {
        return sourceModels;
      }
      return this.providerModelsForType(this.providerTypeForChatSource(sourceId), '');
    },

    chatModelOptions() {
      return this.modelsForChatSource(this.chatSourceId);
    },

    ensureChatModelMatchesSource() {
      const options = this.modelsForChatSource(this.chatSourceId);
      if (!options.length) return;
      if (!this.chatModel || !options.includes(this.chatModel)) {
        this.chatModel = options[0];
      }
    },

    async loadAgentRuntimeProviders() {
      const { ok, data } = await this.api('/api/agent-runtimes/providers');
      if (!ok || !Array.isArray(data?.providers)) return;

      this.agentRuntimeProviders = data.providers;
      if (!this.chatRuntimeProvider || !this.agentRuntimeProviders.some((provider) => provider.id === this.chatRuntimeProvider)) {
        this.chatRuntimeProvider = this.agentRuntimeProviders[0]?.id || 'codex';
        this.syncActiveChatSession();
      }
    },

    async loadAgentRuntimeSessions() {
      this.agentRuntimeSessionsLoading = true;
      const { ok, data } = await this.api('/api/agent-runtimes/sessions?limit=40');
      if (ok && Array.isArray(data?.sessions)) {
        this.agentRuntimeSessions = data.sessions;
        for (const runtimeSession of data.sessions) {
          const localSession = this.findLocalChatSessionByRuntimeId(runtimeSession.id);
          if (!localSession) continue;
          localSession.runtimeStatus = runtimeSession.status || localSession.runtimeStatus || '';
          localSession.title = runtimeSession.title || localSession.title || this.t('newChat');
          localSession.model = runtimeSession.model || localSession.model || '';
          localSession.attachedRuntimeProvider = runtimeSession.provider || localSession.attachedRuntimeProvider || '';
          localSession.attachedRuntimeModel = runtimeSession.model || localSession.attachedRuntimeModel || '';
          localSession.updatedAt = runtimeSession.updatedAt || localSession.updatedAt;
        }
        this.persistChatSessions();
      }
      this.agentRuntimeSessionsLoading = false;
    },

    chatModeLabel(mode) {
      if (mode === 'direct-chat') return this.t('chatModeAssistant');
      return this.t('chatModeAgent');
    },

    chatRuntimeProviderLabel(providerId) {
      if (!providerId) return '';
      const provider = this.agentRuntimeProviders.find((item) => item.id === providerId);
      return provider?.label || provider?.name || providerId;
    },

    agentRuntimeStatusPillClass(status) {
      if (status === 'running') return 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30';
      if (status === 'waiting_user') return 'bg-blue-500/10 text-blue-300 border-blue-500/30';
      if (status === 'waiting_approval') return 'bg-amber-500/10 text-amber-300 border-amber-500/30';
      if (status === 'ready') return 'bg-green-500/10 text-green-300 border-green-500/30';
      if (status === 'failed') return 'bg-red-500/10 text-red-300 border-red-500/30';
      if (status === 'cancelled') return 'bg-gray-500/10 text-gray-300 border-gray-500/30';
      return 'bg-space-800 text-gray-300 border-space-border/40';
    },

    agentRuntimeCwdBasename(cwd) {
      const text = String(cwd || '').trim().replace(/[\\/]+$/, '');
      if (!text) return '';
      const parts = text.split(/[\\/]+/).filter(Boolean);
      return parts[parts.length - 1] || text;
    },

    agentRuntimeGroups() {
      const groupMap = new Map();
      for (const session of this.agentRuntimeSessions || []) {
        const cwd = String(session?.cwd || '').trim();
        const key = cwd || '__no_cwd__';
        if (!groupMap.has(key)) {
          groupMap.set(key, {
            key,
            cwd,
            basename: this.agentRuntimeCwdBasename(cwd),
            sessions: [],
            latestUpdatedAt: ''
          });
        }
        const group = groupMap.get(key);
        group.sessions.push(session);
        if (String(session.updatedAt || '') > String(group.latestUpdatedAt || '')) {
          group.latestUpdatedAt = session.updatedAt || '';
        }
      }
      return [...groupMap.values()].sort((a, b) => {
        if (a.key === '__no_cwd__') return 1;
        if (b.key === '__no_cwd__') return -1;
        return String(b.latestUpdatedAt || '').localeCompare(String(a.latestUpdatedAt || ''));
      });
    },

    isAgentRuntimeCwdCollapsed(group, index) {
      const key = String(group?.key || '');
      if (key in (this.agentRuntimeCollapsedCwds || {})) {
        return this.agentRuntimeCollapsedCwds[key] === true;
      }
      return index !== 0;
    },

    toggleAgentRuntimeCwdGroup(group, index) {
      const key = String(group?.key || '');
      const currentlyCollapsed = this.isAgentRuntimeCwdCollapsed(group, index);
      this.agentRuntimeCollapsedCwds = {
        ...this.agentRuntimeCollapsedCwds,
        [key]: !currentlyCollapsed
      };
    },

    formatRelativeTime(value) {
      if (!value) return '-';
      const time = new Date(value).getTime();
      if (!Number.isFinite(time)) return '-';
      const diffMs = Date.now() - time;
      const diffMin = Math.max(0, Math.floor(diffMs / 60000));
      if (diffMin < 1) return this.t('justNow');
      if (diffMin < 60) return this.t('minutesAgo', diffMin);
      const diffHour = Math.floor(diffMin / 60);
      if (diffHour < 24) return this.t('hoursAgo', diffHour);
      const diffDay = Math.floor(diffHour / 24);
      return this.t('daysAgo', diffDay);
    },

    loadChatSessions() {
      try {
        const raw = localStorage.getItem(this.chatStorageKey);
        const parsed = raw ? JSON.parse(raw) : [];
        this.chatSessions = Array.isArray(parsed) ? parsed : [];
      } catch {
        this.chatSessions = [];
      }

      this.chatSessions.forEach((session) => {
        this.ensureAgentRuntimeSessionDefaults(session);
      });

      if (this.chatSessions.length === 0) {
        this.newChatSession();
        return;
      }

      this.openChatSession(this.chatSessions[0].id);
    },

    persistChatSessions() {
      localStorage.setItem(this.chatStorageKey, JSON.stringify(this.chatSessions.slice(0, 30)));
    },

    chatSessionTitle(session) {
      return session?.title || this.t('newChat');
    },

    buildChatSessionTitle(messages) {
      const firstUserMessage = messages.find((message) => message.role === 'user' && message.content);
      if (!firstUserMessage) return this.t('newChat');
      return firstUserMessage.content.trim().slice(0, 24) || this.t('newChat');
    },

    normalizeBlankChatMode(targetMode) {
      const mode = String(targetMode || '').trim();
      if (mode === 'direct-chat') return 'direct-chat';
      if (mode === 'assistant') return 'assistant';
      if (mode === 'agent-runtime') return 'assistant';
      return 'assistant';
    },

    buildBlankChatSession(targetMode) {
      const mode = this.normalizeBlankChatMode(targetMode);
      const sessionId = 'chat_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      return {
        id: sessionId,
        title: this.t('newChat'),
        mode,
        sourceId: mode === 'direct-chat' ? (this.chatSourceId || this.chatSources[0]?.id || '') : '',
        runtimeProvider: mode !== 'direct-chat' ? (this.chatRuntimeProvider || 'codex') : '',
        runtimeSessionId: '',
        attachedRuntimeProvider: '',
        attachedRuntimeModel: '',
        runtimeStatus: '',
        runtimeLastEventSeq: 0,
        runtimePendingQuestion: null,
        runtimePendingApprovals: [],
        runtimeUnread: false,
        model: mode === 'direct-chat' ? (this.chatModel || 'gpt-5.2') : '',
        assistantMode: this.chatAssistantMode === true,
        systemPrompt: '',
        pendingImage: null,
        messages: [],
        updatedAt: new Date().toISOString()
      };
    },

    switchChatMode(targetMode) {
      const mode = targetMode === 'direct-chat' ? 'direct-chat' : 'assistant';
      if (mode === this.chatMode) return;

      const empty = this.chatSessions.find((s) =>
        s.mode === mode
        && !s.originConversationId
        && (!Array.isArray(s.messages) || s.messages.length === 0)
      );
      if (empty) {
        this.openChatSession(empty.id);
        return;
      }

      const session = this.buildBlankChatSession(mode);
      this.chatSessions.unshift(session);
      this.persistChatSessions();
      this.openChatSession(session.id);
    },

    newChatSession() {
      const session = this.buildBlankChatSession(this.chatMode || 'assistant');
      this.chatSessions.unshift(session);
      this.persistChatSessions();
      this.openChatSession(session.id);
      this.chatHistoryOpen = false;
    },

    openChatSession(sessionId) {
      const session = this.chatSessions.find((item) => item.id === sessionId);
      if (!session) return;

      this.closeAgentRuntimeStream();
      this.stopAssistantRunPolling();
      this.activeChatSessionId = session.id;
      this.chatMode = session.mode || 'assistant';
      this.chatSourceId = session.sourceId || this.chatSources[0]?.id || '';
      this.chatRuntimeProvider = session.runtimeProvider || 'codex';
      if (session.model) {
        this.chatModel = session.model;
      } else if (!this.chatModel) {
        this.chatModel = 'gpt-5.2';
      }
      this.chatAssistantMode = session.assistantMode !== false;
      this.chatSystemPrompt = session.systemPrompt || '';
      this.chatMessages = Array.isArray(session.messages) ? session.messages : [];
      this.chatInput = '';
      this.chatPendingImage = session.pendingImage || null;
      session.runtimeLastEventSeq = Number(session.runtimeLastEventSeq || 0);
      session.runtimeUnread = false;
      if (!Array.isArray(session.runtimePendingApprovals)) {
        session.runtimePendingApprovals = [];
      }
      if (window.innerWidth < 1280) {
        this.chatHistoryOpen = false;
      }
      this.scrollChatToBottom();
      this.refreshChatSessionFromServer(session.id);
      if (session.mode === 'agent-runtime' && session.runtimeSessionId) {
        this.connectAgentRuntimeStream(session);
      }
      if (session.pendingAssistantRunId) {
        this.connectAssistantRunTraceStream(session.pendingAssistantRunId);
      }
    },

    shouldStickChatToBottom(threshold = 96) {
      const container = this.$refs?.chatMessagesContainer;
      if (!container) return true;
      const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      return distanceToBottom <= threshold;
    },

    scrollChatToBottom(force = false) {
      const container = this.$refs?.chatMessagesContainer;
      if (!container) return;
      if (!force && !this.shouldStickChatToBottom()) return;
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    },

    getActiveChatSession() {
      return this.chatSessions.find((item) => item.id === this.activeChatSessionId) || null;
    },

    closeAgentRuntimeStream() {
      if (this.chatRuntimeEventSource) {
        this.chatRuntimeEventSource.close();
        this.chatRuntimeEventSource = null;
      }
    },

    closeAssistantRunTraceStream() {
      if (this.chatAssistantRunEventSource) {
        this.chatAssistantRunEventSource.close();
        this.chatAssistantRunEventSource = null;
      }
    },

    stopAssistantRunPolling() {
      if (this.chatAssistantRunPoller) {
        clearTimeout(this.chatAssistantRunPoller);
        this.chatAssistantRunPoller = null;
      }
    },

    connectAgentRuntimeStream(session) {
      if (!session?.runtimeSessionId) return;
      const isCurrentSession = session.id === this.activeChatSessionId;
      if (!isCurrentSession) return;

      this.closeAgentRuntimeStream();
      const afterSeq = Number(session.runtimeLastEventSeq || 0);
      const url = `/api/agent-runtimes/sessions/${encodeURIComponent(session.runtimeSessionId)}/stream?history=true&afterSeq=${afterSeq}`;
      const source = new EventSource(url);
      this.chatRuntimeEventSource = source;

      source.onmessage = (event) => {
        let payload = null;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        this.applyAgentRuntimeEvent(session.id, payload);
      };

      source.onerror = () => {
        const active = this.getActiveChatSession();
        if (!active || active.id !== session.id) {
          this.closeAgentRuntimeStream();
        }
      };
    },

    connectAssistantRunTraceStream(runId) {
      const normalizedRunId = String(runId || '').trim();
      if (!normalizedRunId) return;
      this.closeAssistantRunTraceStream();
      const afterSeq = Number(this.chatAssistantRunLastSeq?.[normalizedRunId] || 0);
      const source = new EventSource(`/api/assistant/runs/${encodeURIComponent(normalizedRunId)}/stream?history=true&afterSeq=${afterSeq}`);
      this.chatAssistantRunEventSource = source;

      source.onmessage = (event) => {
        let payload = null;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        this.applyAssistantRunTraceEvent(payload);
      };

      source.onerror = () => {
        const activeRunId = this.getActiveChatSession()?.pendingAssistantRunId || '';
        if (!activeRunId || activeRunId !== normalizedRunId) {
          this.closeAssistantRunTraceStream();
        }
      };
    },

    applyAssistantRunTraceEvent(event) {
      const runId = String(event?.runId || '').trim();
      if (!runId) return;
      this.applyChatTraceEvent(runId, event);
    },

    applyChatTraceEvent(traceId, event) {
      const runId = String(traceId || event?.runId || '').trim();
      if (!runId) return;
      const seq = Number(event.seq || 0);
      const lastSeq = Number(this.chatAssistantRunLastSeq?.[runId] || 0);
      if (seq && seq <= lastSeq) return;
      this.chatAssistantRunLastSeq = {
        ...(this.chatAssistantRunLastSeq || {}),
        [runId]: seq || lastSeq
      };
      const existing = Array.isArray(this.chatAssistantRunEvents?.[runId])
        ? this.chatAssistantRunEvents[runId]
        : [];
      this.chatAssistantRunEvents = {
        ...(this.chatAssistantRunEvents || {}),
        [runId]: [...existing, { ...event, runId }].slice(-300)
      };
      this.syncTraceToAssistantRunMessages(runId);
    },

    syncTraceToAssistantRunMessages(runId) {
      const normalizedRunId = String(runId || '').trim();
      if (!normalizedRunId) return;
      const events = this.assistantRunTraceEvents(normalizedRunId);
      const latest = events[events.length - 1] || null;
      for (const session of this.chatSessions || []) {
        let changed = false;
        session.messages = (session.messages || []).map((message) => {
          const messageTraceId = this.chatMessageTraceId(message);
          if (messageTraceId !== normalizedRunId) {
            return message;
          }
          changed = true;
          return {
            ...message,
            traceEventCount: events.length,
            traceLatest: latest,
            traceOpen: this.isAssistantRunTraceOpen(normalizedRunId)
          };
        });
        if (changed && session.id === this.activeChatSessionId) {
          this.chatMessages = [...session.messages];
        }
      }
    },

    activeAssistantRunId() {
      const session = this.getActiveChatSession ? this.getActiveChatSession() : null;
      const pendingRunId = String(session?.pendingAssistantRunId || '').trim();
      if (pendingRunId) return pendingRunId;
      const messages = Array.isArray(session?.messages) ? session.messages : [];
      const latest = [...messages].reverse().find((message) => String(message?.assistantRunId || '').trim());
      return String(latest?.assistantRunId || '').trim();
    },

    chatMessageTraceId(message = {}) {
      if (message.traceAnchor === true) {
        return String(message.assistantRunId || message.runtimeTraceId || '').trim();
      }
      // Explicit traceAnchor:false keeps the trace panel hidden (used when a
      // message must NOT carry execution metadata even though it has a runId
      // — e.g. legacy persisted messages that pre-date the trace pipeline).
      if (message.traceAnchor === false) {
        return String(message.runtimeTraceId || '').trim();
      }
      // No explicit anchor → default to "surface the trace panel for any
      // assistant message tied to a concrete assistant run id". Before this
      // change only the placeholder "started" message carried traceAnchor=true,
      // so once the final reply arrived the trace panel disappeared and the
      // user could no longer click in to see what the run actually did.
      const role = String(message?.role || '');
      const runId = String(message?.assistantRunId || '').trim();
      if (role === 'assistant' && runId) {
        return runId;
      }
      return String(message.runtimeTraceId || '').trim();
    },

    // Auto-expand the execution trace for runs that are still alive. The
    // moment a user sees an assistant message that is mid-flight, the trace
    // panel is already open so they can watch the LLM's thinking and tool
    // calls stream in. Once the run reaches a terminal state the auto flag
    // is removed; if the user explicitly toggled the panel closed (via the
    // chevron) we respect that and do NOT force it back open.
    isAssistantRunTraceOpenAuto(runId) {
      const normalizedRunId = String(runId || '').trim();
      if (!normalizedRunId) return false;
      const explicit = this.chatAssistantRunTraceOpen?.[normalizedRunId];
      if (explicit === false) return false;
      if (explicit === true) return true;
      const activeRunId = this.activeAssistantRunId ? this.activeAssistantRunId() : '';
      if (activeRunId && activeRunId === normalizedRunId) return true;
      return false;
    },

    assistantRunTraceEvents(runId) {
      const normalizedRunId = String(runId || '').trim();
      return Array.isArray(this.chatAssistantRunEvents?.[normalizedRunId])
        ? this.chatAssistantRunEvents[normalizedRunId]
        : [];
    },

    assistantRunTracePreview(runId) {
      return this.assistantRunTraceEvents(runId)
        .filter((event) => event?.visibility !== 'hidden')
        .slice(-8);
    },

    isAssistantRunTraceOpen(runId) {
      const normalizedRunId = String(runId || '').trim();
      if (this.chatAssistantRunTraceOpen?.[normalizedRunId] === true) return true;
      if (this.chatAssistantRunTraceOpen?.[normalizedRunId] === false) return false;
      // No explicit user choice yet — auto-open while the run is still active
      // so the user sees the execution stream in real time.
      return this.isAssistantRunTraceOpenAuto(normalizedRunId);
    },

    toggleAssistantRunTrace(runId) {
      const normalizedRunId = String(runId || '').trim();
      if (!normalizedRunId) return;
      this.chatAssistantRunTraceOpen = {
        ...(this.chatAssistantRunTraceOpen || {}),
        [normalizedRunId]: !this.isAssistantRunTraceOpen(normalizedRunId)
      };
      this.syncTraceToAssistantRunMessages(normalizedRunId);
      if (this.isAssistantRunTraceOpen(normalizedRunId) && !normalizedRunId.startsWith('runtime:')) {
        this.connectAssistantRunTraceStream(normalizedRunId);
      }
    },

    assistantRunTraceStatus(runId) {
      const events = this.assistantRunTraceEvents(runId);
      const latest = events[events.length - 1] || null;
      if (!latest) return this.t('assistantTraceWaiting');
      const title = latest.title || latest.summary || latest.type || '';
      const status = latest.status || latest.phase || '';
      return [status, title].filter(Boolean).join(' · ');
    },

    assistantRunTraceEventTitle(event) {
      if (!event) return '';
      return event.title || event.summary || event.type || '';
    },

    assistantRunTraceEventSummary(event) {
      if (!event) return '';
      const summary = String(event.summary || '').trim();
      if (summary) return this.truncateTraceText(summary);
      const payloadSummary = event.payload?.summary || event.payload?.text || '';
      return this.truncateTraceText(String(payloadSummary || '').trim());
    },

    truncateTraceText(text, limit = 4000) {
      const value = String(text || '');
      if (value.length <= limit) return value;
      const head = Math.floor(limit / 2);
      const tail = limit - head;
      return `${value.slice(0, head)}\n...[truncated ${value.length - limit} chars]...\n${value.slice(-tail)}`;
    },

    assistantRunTraceEventClass(event) {
      const type = String(event?.type || '');
      const status = String(event?.status || '');
      if (type.includes('failed') || status === 'failed') return 'border-red-500/30 bg-red-500/5';
      if (type.includes('command')) return 'border-amber-500/25 bg-amber-500/5';
      if (type.includes('file')) return 'border-emerald-500/25 bg-emerald-500/5';
      if (type.includes('tool')) return 'border-cyan-500/25 bg-cyan-500/5';
      if (type.includes('runtime')) return 'border-violet-500/25 bg-violet-500/5';
      if (type.includes('completed')) return 'border-emerald-500/25 bg-emerald-500/5';
      return 'border-space-border/30 bg-space-950/40';
    },

    runtimeTraceId(session, event = {}) {
      const sessionId = String(session?.runtimeSessionId || event?.sessionId || '').trim();
      if (!sessionId) return '';
      const turnId = String(event?.turnId || event?.payload?.turnId || '').trim();
      return ['runtime', sessionId, turnId || 'active'].join(':');
    },

    ensureRuntimeTraceMessage(chatSessionId, traceId, event = {}) {
      const session = this.chatSessions.find((item) => item.id === chatSessionId);
      if (!session || !traceId) return;
      const existing = (session.messages || []).some((message) => message.runtimeTraceId === traceId);
      if (existing) return;
      const payload = event.payload || {};
      this.appendAgentRuntimeMessage(chatSessionId, {
        kind: 'agent-trace',
        content: this.t('agentRuntimeTraceStarted'),
        runtimeTraceId: traceId,
        runtimeSessionId: String(session.runtimeSessionId || event.sessionId || ''),
        turnId: String(event.turnId || payload.turnId || ''),
        traceEventCount: 0
      });
    },

    appendRuntimeTraceEvent(chatSessionId, event, {
      type = '',
      phase = '',
      status = '',
      title = '',
      summary = '',
      payload = {},
      visibility = 'detail'
    } = {}) {
      const session = this.chatSessions.find((item) => item.id === chatSessionId);
      if (!session) return '';
      const traceId = this.runtimeTraceId(session, event);
      if (!traceId) return '';
      this.ensureRuntimeTraceMessage(chatSessionId, traceId, event);
      this.applyChatTraceEvent(traceId, {
        runId: traceId,
        seq: Number(event.seq || 0),
        ts: event.ts || new Date().toISOString(),
        type,
        phase,
        status,
        title,
        summary,
        payload,
        visibility
      });
      return traceId;
    },

    ensureAgentRuntimeSessionDefaults(session) {
      if (!session) return;
      const normalizedMode = String(session.mode || '').trim();
      const hasRuntimeBinding = Boolean(
        String(session.runtimeSessionId || '').trim()
        || String(session.originConversationId || '').trim()
      );
      if (normalizedMode === 'agent-runtime' && !hasRuntimeBinding) {
        session.mode = 'assistant';
      } else if (normalizedMode === 'direct-runtime') {
        session.mode = 'assistant';
      } else if (!normalizedMode) {
        session.mode = hasRuntimeBinding ? 'agent-runtime' : 'assistant';
      }
      session.runtimeProvider = session.runtimeProvider || this.chatRuntimeProvider || 'codex';
      session.runtimeSessionId = session.runtimeSessionId || '';
      session.attachedRuntimeProvider = session.attachedRuntimeProvider || '';
      session.attachedRuntimeModel = session.attachedRuntimeModel || '';
      session.runtimeStatus = session.runtimeStatus || '';
      session.runtimeLastEventSeq = Number(session.runtimeLastEventSeq || 0);
      session.runtimePendingQuestion = session.runtimePendingQuestion || null;
      session.pendingAssistantRunId = session.pendingAssistantRunId || '';
      session.runtimeUnread = session.runtimeUnread === true;
      if (!Array.isArray(session.runtimePendingApprovals)) {
        session.runtimePendingApprovals = [];
      }
      if (Array.isArray(session.messages)) {
        session.messages.forEach((message) => {
          if (message && message.kind === 'agent-command' && typeof message.commandOutputCollapsed !== 'boolean') {
            message.commandOutputCollapsed = true;
          }
        });
      }
    },

    async pollAssistantRunUntilFinal(sessionId, runId, attempts = 0) {
      const session = this.chatSessions.find((item) => item.id === sessionId);
      if (!session || !runId || session.pendingAssistantRunId !== runId) {
        return;
      }

      const { ok, data } = await this.api(`/api/assistant/runs/${encodeURIComponent(runId)}`);
      const run = ok ? data?.run : null;
      const terminal = ['completed', 'failed', 'cancelled', 'waiting_user'];

      if (run && terminal.includes(String(run.status || ''))) {
        session.pendingAssistantRunId = '';
        if (this.chatAssistantRunEventSource) {
          this.closeAssistantRunTraceStream();
        }
        await this.refreshChatSessionFromServer(session.id);
        const mergedPersisted = Array.isArray(session.messages)
          && session.messages.some((message) => (
            String(message.assistantRunId || '') === String(run.id || '')
            && String(message.runStatus || '') === String(run.status || '')
          ));
        if (!mergedPersisted) {
          this.appendAgentRuntimeMessage(session.id, {
            kind: 'agent-status',
            content: run.result || run.summary || this.t('requestFailed'),
            isError: run.status === 'failed',
            assistantRunId: run.id,
            runStatus: run.status,
            observability: run.metadata?.stopPolicy || run.metadata?.agent || run.metadata?.assistantAgent
              ? {
                mode: run.metadata?.assistantAgent?.mode === 'fallback' ? 'fallback' : 'agent',
                resolvedSource: run.metadata?.agent?.llmSource || null,
                fallbackReason: run.metadata?.assistantAgent?.reason || '',
                stopPolicy: run.metadata?.stopPolicy || null
              }
              : null
          });
        }
        this.syncActiveChatSession();
        return;
      }

      if (attempts >= 60) {
        return;
      }

      this.chatAssistantRunPoller = setTimeout(() => {
        this.pollAssistantRunUntilFinal(sessionId, runId, attempts + 1);
      }, 1000);
    },

    appendAgentRuntimeMessage(sessionId, message) {
      const session = this.chatSessions.find((item) => item.id === sessionId);
      if (!session) return;

      const nextMessage = {
        role: 'assistant',
        kind: 'agent-message',
        ...message
      };
      session.messages = [...(session.messages || []), nextMessage];
      if (session.id === this.activeChatSessionId) {
        this.chatMessages = [...session.messages];
        this.scrollChatToBottom(true);
      }
    },

    chatMessageSignature(message = {}) {
      const role = String(message.role || '');
      const kind = String(message.kind || '');
      const assistantRunId = String(message.assistantRunId || '');
      const runStatus = String(message.runStatus || '');
      const content = String(message.content || '');
      return [role, kind, assistantRunId, runStatus, content].join('|');
    },

    mergePersistedChatMessages(session, persistedMessages = []) {
      if (!session || !Array.isArray(persistedMessages) || persistedMessages.length === 0) {
        return false;
      }

      const existingMessages = Array.isArray(session.messages) ? session.messages : [];
      const seen = new Set(existingMessages.map((message) => this.chatMessageSignature(message)));
      const normalized = persistedMessages
        .filter((message) => message && typeof message === 'object')
        .map((message) => ({
          role: message.role || 'assistant',
          kind: message.kind || 'agent-message',
          content: String(message.content || ''),
          assistantRunId: String(message.assistantRunId || ''),
          runStatus: String(message.runStatus || ''),
          traceAnchor: message.traceAnchor === true,
          pendingAction: message.pendingAction || null,
          observability: message.observability || null,
          createdAt: message.createdAt || ''
        }))
        .filter((message) => {
          const signature = this.chatMessageSignature(message);
          if (seen.has(signature)) {
            return false;
          }
          seen.add(signature);
          return true;
        });

      if (normalized.length === 0) {
        return false;
      }

      const sorted = normalized.sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
      session.messages = [...existingMessages, ...sorted];
      const completed = sorted.find((message) => (
        message.assistantRunId
        && ['completed', 'failed', 'cancelled'].includes(String(message.runStatus || ''))
      ));
      if (completed && session.pendingAssistantRunId === completed.assistantRunId) {
        session.pendingAssistantRunId = '';
      }
      if (session.id === this.activeChatSessionId) {
        this.chatMessages = [...session.messages];
        this.scrollChatToBottom(true);
      }
      for (const message of sorted) {
        if (message.assistantRunId) {
          this.connectAssistantRunTraceStream(message.assistantRunId);
          break;
        }
      }
      return true;
    },

    async refreshChatSessionFromServer(sessionId) {
      const session = this.chatSessions.find((item) => item.id === sessionId);
      if (!session) return;

      const { ok, data } = await this.api(`/api/chat/sessions/${encodeURIComponent(sessionId)}`);
      if (!ok || !data?.session) {
        return;
      }

      const serverSession = data.session;
      if (serverSession.activeRuntimeSessionId) {
        session.runtimeSessionId = serverSession.activeRuntimeSessionId;
      }

      const merged = this.mergePersistedChatMessages(session, serverSession.uiChatMessages || []);
      if (merged) {
        session.updatedAt = new Date().toISOString();
        this.syncActiveChatSession();
      }
    },

    formatAssistantRunObservability(observability, runStatus = '') {
      const meta = observability && typeof observability === 'object' ? observability : null;
      if (!meta) return '';
      const lines = [];
      const mode = String(meta.mode || '').trim();
      const resolvedSource = meta.resolvedSource && typeof meta.resolvedSource === 'object'
        ? meta.resolvedSource
        : null;
      const fallbackReason = String(meta.fallbackReason || '').trim();
      const stopPolicy = meta.stopPolicy && typeof meta.stopPolicy === 'object'
        ? meta.stopPolicy
        : null;

      if (mode === 'fallback') {
        lines.push(`mode: fallback${fallbackReason ? ` (${fallbackReason})` : ''}`);
      } else if (mode) {
        lines.push(`mode: ${mode}`);
      }

      if (resolvedSource) {
        const sourceParts = [
          resolvedSource.label || '',
          resolvedSource.model || ''
        ].filter(Boolean);
        lines.push(`source: ${sourceParts.join(' / ') || (resolvedSource.kind || 'resolved')}`);
      }

      if (runStatus) {
        lines.push(`run: ${String(runStatus).trim()}`);
      }

      if (stopPolicy) {
        const closure = String(stopPolicy.closure || '').trim();
        const reason = String(stopPolicy.reason || '').trim();
        const label = closure || String(stopPolicy.status || '').trim();
        if (label) {
          lines.push(`closure: ${label}${reason ? ` (${reason})` : ''}`);
        }
      }

      return lines.join('\n');
    },

    updateAgentRuntimeMessage(sessionId, predicate, updater) {
      const session = this.chatSessions.find((item) => item.id === sessionId);
      if (!session || !Array.isArray(session.messages)) return false;
      const index = session.messages.findIndex(predicate);
      if (index < 0) return false;
      session.messages[index] = updater({ ...session.messages[index] });
      if (session.id === this.activeChatSessionId) {
        this.chatMessages = [...session.messages];
      }
      return true;
    },

    activeRuntimeSessionBadge(session = this.getActiveChatSession()) {
      if (!session?.runtimeSessionId) {
        return this.t('agentRuntimeNoAttachedSession');
      }
      return `${this.t('agentRuntimeSessionShort')} ${String(session.runtimeSessionId).slice(0, 8)}`;
    },

    runtimeSessionConfigChanged(session) {
      if (!session?.runtimeSessionId) return false;
      // Assistant lane: the user doesn't pick provider/model in the UI — the
      // backend Assistant Agent + bound CLI decide. Comparing the frontend's
      // chatRuntimeProvider against whatever the runtime actually resolved
      // would produce a "provider changed" false positive on every follow-up
      // turn and inject a noisy "已切换到新会话" notice into the message stream.
      if (session?.mode === 'agent-runtime') return false;
      const selectedProvider = String(this.chatRuntimeProvider || session.runtimeProvider || 'codex').trim();
      const selectedModel = String(session.model || '').trim();
      const attachedProvider = String(session.attachedRuntimeProvider || '').trim();
      const attachedModel = String(session.attachedRuntimeModel || '').trim();
      if (attachedProvider && selectedProvider && attachedProvider !== selectedProvider) {
        return true;
      }
      if (!attachedModel || !selectedModel) return false;
      return attachedModel !== selectedModel;
    },

    buildRuntimeSessionRestartNotice(session) {
      const reasons = [];
      const selectedProvider = String(this.chatRuntimeProvider || session?.runtimeProvider || 'codex').trim();
      const selectedModel = String(session?.model || '').trim();
      const attachedProvider = String(session?.attachedRuntimeProvider || '').trim();
      const attachedModel = String(session?.attachedRuntimeModel || '').trim();
      if (attachedProvider && selectedProvider && attachedProvider !== selectedProvider) {
        reasons.push(this.t('agentRuntimeProviderChanged'));
      }
      if (attachedModel && selectedModel && attachedModel !== selectedModel) {
        reasons.push(this.t('agentRuntimeModelChanged'));
      }
      const detail = reasons.length > 0
        ? `${this.t('agentRuntimeStartedFreshBecause')} ${reasons.join(', ')}.`
        : this.t('agentRuntimeDetachedNotice');
      return `${this.t('agentRuntimeFreshSessionReady')} ${detail}`;
    },

    resetActiveRuntimeBinding({ mode = 'agent-runtime', notice = '' } = {}) {
      const session = this.getActiveChatSession();
      if (!session) return;
      this.ensureAgentRuntimeSessionDefaults(session);
      if (session.id === this.activeChatSessionId) {
        this.closeAgentRuntimeStream();
      }
      session.mode = mode;
      session.runtimeSessionId = '';
      session.attachedRuntimeProvider = '';
      session.attachedRuntimeModel = '';
      session.runtimeStatus = '';
      session.runtimeLastEventSeq = 0;
      session.runtimePendingQuestion = null;
      session.runtimePendingApprovals = [];
      session.runtimeUnread = false;
      if (notice) {
        this.appendAgentRuntimeMessage(session.id, {
          kind: 'agent-status',
          content: notice
        });
      }
      this.syncActiveChatSession();
    },

    startFreshAgentRuntimeSession() {
      this.resetActiveRuntimeBinding({
        mode: 'agent-runtime',
        notice: this.t('agentRuntimeFreshSessionReady')
      });
    },

    detachAgentRuntimeSession() {
      const session = this.getActiveChatSession();
      if (!session?.runtimeSessionId) return;
      this.resetActiveRuntimeBinding({
        mode: 'agent-runtime',
        notice: this.t('agentRuntimeDetachedNotice')
      });
    },

    applyAgentRuntimeEvent(chatSessionId, event) {
      const session = this.chatSessions.find((item) => item.id === chatSessionId);
      if (!session || !event) return;
      this.ensureAgentRuntimeSessionDefaults(session);
      const seq = Number(event.seq || 0);
      if (seq && seq <= Number(session.runtimeLastEventSeq || 0)) return;
      if (seq) {
        session.runtimeLastEventSeq = seq;
      }
      const payload = event.payload || {};
      const isActiveSession = session.id === this.activeChatSessionId;
      const isForegroundSession = isActiveSession && this.activeTab === 'chat';
      if (event.type === 'worker.started') {
        session.runtimeStatus = 'running';
        this.appendRuntimeTraceEvent(chatSessionId, event, {
          type: 'runtime.started',
          phase: 'runtime',
          status: 'running',
          title: this.t('agentRuntimeTraceStarted'),
          summary: payload.provider ? `${payload.provider} runtime started.` : this.t('agentRuntimeTraceStarted'),
          payload,
          visibility: 'compact'
        });
      } else if (event.type === 'worker.input') {
        this.appendRuntimeTraceEvent(chatSessionId, event, {
          type: 'runtime.input',
          phase: 'input',
          status: 'completed',
          title: this.t('agentRuntimeDispatch'),
          summary: payload.text || '',
          payload,
          visibility: 'detail'
        });
      } else if (event.type === 'worker.message') {
        this.appendAgentRuntimeMessage(chatSessionId, { content: payload.text || '', itemType: payload.itemType || 'assistant' });
      } else if (event.type === 'worker.command') {
        this.appendRuntimeTraceEvent(chatSessionId, event, {
          type: 'runtime.command',
          phase: 'command',
          status: payload.status || '',
          title: payload.command || this.t('agentRuntimeCommand'),
          summary: payload.output || payload.command || '',
          payload: {
            command: payload.command || '',
            output: payload.output || '',
            exitCode: payload.exitCode,
            status: payload.status || ''
          },
          visibility: 'detail'
        });
      } else if (event.type === 'worker.file_change') {
        const changes = Array.isArray(payload.changes) ? payload.changes : [];
        this.appendRuntimeTraceEvent(chatSessionId, event, {
          type: 'runtime.file_change',
          phase: 'file',
          status: payload.status || '',
          title: this.t('agentRuntimeFilesChanged'),
          summary: changes.join('\n') || this.t('agentRuntimeFilesChanged'),
          payload: {
            changes,
            status: payload.status || ''
          },
          visibility: 'detail'
        });
      } else if (event.type === 'worker.progress') {
        const title = payload.phase === 'todo_list'
          ? this.t('agentRuntimeTraceTodo')
          : (payload.phase || this.t('agentRuntimeTraceProgress'));
        const summary = Array.isArray(payload.items)
          ? payload.items.map((item) => item?.text || item?.title || String(item || '')).filter(Boolean).join('\n')
          : (payload.text || payload.summary || '');
        this.appendRuntimeTraceEvent(chatSessionId, event, {
          type: 'runtime.progress',
          phase: payload.phase || 'progress',
          status: payload.status || 'running',
          title,
          summary,
          payload,
          visibility: payload.phase === 'reasoning' ? 'debug' : 'detail'
        });
      } else if (event.type === 'worker.question') {
        session.runtimeStatus = 'waiting_user';
        session.runtimePendingQuestion = payload;
        this.appendRuntimeTraceEvent(chatSessionId, event, {
          type: 'runtime.question',
          phase: 'question',
          status: 'waiting_user',
          title: this.t('agentRuntimeQuestion'),
          summary: payload.text || this.t('agentRuntimeQuestion'),
          payload,
          visibility: 'compact'
        });
        if (!isForegroundSession) {
          session.runtimeUnread = true;
          this.showToast(this.t('agentRuntimeQuestionToast', this.chatSessionTitle(session)), 'warning');
        }
        this.appendAgentRuntimeMessage(chatSessionId, {
          kind: 'agent-question',
          content: payload.text || this.t('agentRuntimeQuestion'),
          questionId: payload.questionId,
          questionStatus: payload.status || 'pending'
        });
      } else if (event.type === 'worker.approval_request') {
        session.runtimeStatus = 'waiting_approval';
        session.runtimePendingApprovals = [...session.runtimePendingApprovals, payload];
        this.appendRuntimeTraceEvent(chatSessionId, event, {
          type: 'runtime.approval_request',
          phase: 'approval',
          status: 'waiting_approval',
          title: payload.title || this.t('agentRuntimeApproval'),
          summary: payload.summary || '',
          payload,
          visibility: 'compact'
        });
        if (!isForegroundSession) {
          session.runtimeUnread = true;
          this.showToast(this.t('agentRuntimeApprovalToast', this.chatSessionTitle(session)), 'warning');
        }
        this.appendAgentRuntimeMessage(chatSessionId, {
          kind: 'agent-approval',
          content: payload.title || this.t('agentRuntimeApproval'),
          approvalId: payload.approvalId,
          approvalSummary: payload.summary || '',
          approvalStatus: payload.status || 'pending'
        });
      } else if (event.type === 'worker.approval_resolved') {
        const approvalId = payload.approvalId;
        session.runtimePendingApprovals = session.runtimePendingApprovals.filter((item) => item.approvalId !== approvalId);
        session.runtimeStatus = session.runtimePendingApprovals.length > 0
          ? 'waiting_approval'
          : (session.runtimePendingQuestion ? 'waiting_user' : 'running');
        this.appendRuntimeTraceEvent(chatSessionId, event, {
          type: 'runtime.approval_resolved',
          phase: 'approval',
          status: 'completed',
          title: this.t('agentRuntimeApproval'),
          summary: payload.decision || 'resolved',
          payload,
          visibility: 'detail'
        });
        this.updateAgentRuntimeMessage(
          chatSessionId,
          (message) => message.kind === 'agent-approval' && message.approvalId === approvalId,
          (message) => ({
            ...message,
            approvalStatus: payload.decision || 'resolved'
          })
        );
      } else if (event.type === 'worker.completed') {
        session.runtimeStatus = 'ready';
        session.runtimePendingQuestion = null;
        session.runtimePendingApprovals = [];
        this.appendRuntimeTraceEvent(chatSessionId, event, {
          type: 'runtime.completed',
          phase: 'finish',
          status: 'completed',
          title: this.t('agentRuntimeCompleted'),
          summary: payload.summary || payload.result || this.t('agentRuntimeCompleted'),
          payload,
          visibility: 'compact'
        });
        if (!isForegroundSession) {
          session.runtimeUnread = true;
          this.showToast(this.t('agentRuntimeCompletedToast', this.chatSessionTitle(session)), 'success');
        }
        if (isActiveSession) {
          this.closeAgentRuntimeStream();
        }
      } else if (event.type === 'worker.failed') {
        session.runtimeStatus = 'failed';
        this.appendRuntimeTraceEvent(chatSessionId, event, {
          type: 'runtime.failed',
          phase: 'finish',
          status: 'failed',
          title: this.t('requestFailed'),
          summary: payload.message || this.t('requestFailed'),
          payload,
          visibility: 'compact'
        });
        if (!isForegroundSession) {
          session.runtimeUnread = true;
          this.showToast(this.t('agentRuntimeFailedToast', this.chatSessionTitle(session)), 'error');
        }
        if (isActiveSession) {
          this.closeAgentRuntimeStream();
        }
        this.appendAgentRuntimeMessage(chatSessionId, {
          kind: 'agent-status',
          content: payload.message || this.t('requestFailed'),
          isError: true
        });
      }
      this.syncActiveChatSession();
    },

    chatSendDisabled() {
      if (this.chatLoading) return true;
      if (this.chatMode === 'direct-chat') {
        return !this.chatSourceId;
      }
      const session = this.getActiveChatSession();
      if (session?.runtimePendingApprovals?.length) {
        return true;
      }
      if (!this.chatRuntimeProvider) {
        return true;
      }
      if (this.chatMode === 'assistant') {
        return !String(this.chatInput || '').trim() && !this.chatPendingImage;
      }
      return !String(this.chatInput || '').trim();
    },

    syncActiveChatSession() {
      const session = this.chatSessions.find((item) => item.id === this.activeChatSessionId);
      if (!session) return;
      const mode = this.chatMode || 'assistant';
      session.mode = mode;
      if (mode === 'direct-chat') {
        // Model-chat mode: user explicitly picks source + model in the UI;
        // mirror them onto the session so reloads remember the choice.
        session.sourceId = this.chatSourceId || '';
        session.model = (this.chatModel || '').trim();
        session.systemPrompt = this.chatSystemPrompt || '';
        session.runtimeProvider = '';
      } else {
        // Assistant (agent-runtime) mode: backend / CLI decides model.
        // Never overwrite session.model from the frontend's chatModel state —
        // that state belongs to the model-chat lane and would be a category
        // mismatch for the runtime CLI (e.g. 'gpt-5.2' fed to claude-code).
        session.runtimeProvider = this.chatRuntimeProvider || session.runtimeProvider || 'codex';
        if (!('sourceId' in session)) session.sourceId = '';
        if (!('model' in session)) session.model = '';
        if (!('systemPrompt' in session)) session.systemPrompt = '';
      }
      session.pendingImage = this.chatPendingImage || null;
      session.assistantMode = this.chatAssistantMode === true;
      session.messages = [...this.chatMessages];
      session.title = this.buildChatSessionTitle(session.messages);
      session.updatedAt = new Date().toISOString();
      this.chatSessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      this.persistChatSessions();
    },

    removeChatSession(sessionId) {
      const index = this.chatSessions.findIndex((item) => item.id === sessionId);
      if (index < 0) return;
      if (this.activeChatSessionId === sessionId) {
        this.closeAgentRuntimeStream();
        this.closeAssistantRunTraceStream();
      }
      this.chatSessions.splice(index, 1);
      if (this.activeChatSessionId === sessionId) {
        if (this.chatSessions.length === 0) {
          this.activeChatSessionId = '';
          this.chatMessages = [];
          this.chatSystemPrompt = '';
          this.chatInput = '';
          this.chatPendingImage = null;
          this.newChatSession();
          return;
        }
        this.openChatSession(this.chatSessions[0].id);
      }
      this.persistChatSessions();
    },

    async sendChatMessage() {
      const hasText = Boolean(String(this.chatInput || '').trim());
      const hasPendingImage = Boolean(this.chatPendingImage);
      if (this.chatLoading) return;
      if (this.chatMode === 'assistant') {
        if (!hasText && !hasPendingImage) return;
      } else if (!hasText) {
        return;
      }
      if (this.chatMode === 'assistant') {
        await this.sendAssistantConversationMessage();
        return;
      }
      if (this.chatMode === 'agent-runtime') {
        await this.sendAgentRuntimeMessage();
        return;
      }
      await this.sendDirectChatMessage();
    },

    async sendDirectChatMessage() {
      if (!this.chatSourceId) return;

      const shouldAutoScroll = this.shouldStickChatToBottom();
      const userMessage = { role: 'user', content: this.chatInput.trim(), _origin: 'web' };
      this.chatMessages.push(userMessage);
      this.chatInput = '';
      this.syncActiveChatSession();
      this.chatLoading = true;
      this.scrollChatToBottom(shouldAutoScroll);

      const assistantMessage = {
        role: 'assistant',
        content: '',
        usage: null,
        model: this.chatModel.trim() || 'gpt-5.2',
        mappedModel: null,
        sourceLabel: this.chatSourceLabel(this.chatSourceId),
        citations: [],
        pendingAction: null,
        _confirming: false,
        _origin: 'web'
      };
      this.chatMessages.push(assistantMessage);
      this.syncActiveChatSession();
      this.scrollChatToBottom(true);

      const requestMessages = [];
      if (this.chatSystemPrompt.trim()) {
        requestMessages.push({ role: 'system', content: this.chatSystemPrompt.trim() });
      }
      for (const message of this.chatMessages) {
        if (message === assistantMessage) continue;
        requestMessages.push({ role: message.role, content: message.content });
      }

      this.chatStreamController = new AbortController();
      const sentSourceId = this.chatSourceId;
      const startedAt = Date.now();

      try {
        const response = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceId: this.chatSourceId,
            model: this.chatModel.trim() || 'gpt-5.2',
            messages: requestMessages,
            assistantMode: this.chatMode !== 'direct-chat' && this.chatAssistantMode === true,
            uiLang: this.lang
          }),
          signal: this.chatStreamController.signal
        });

        if (!response.ok || !response.body) {
          const errorText = await response.text();
          const detail = this.classifyChatError(response.status, errorText);
          const err = new Error(detail.message);
          err._detail = detail;
          throw err;
        }

        const streamResult = await this.consumeChatStream(response.body, assistantMessage);
        if (!assistantMessage.content && !assistantMessage.isError) {
          await this.fetchChatCompletionFallback(requestMessages, assistantMessage);
        } else if (!streamResult.seenDelta && !streamResult.seenDone && !assistantMessage.isError) {
          await this.fetchChatCompletionFallback(requestMessages, assistantMessage);
        }
        this.recordChatSourceHealth(sentSourceId, Date.now() - startedAt, !assistantMessage.isError);
      } catch (error) {
        const detail = error._detail || this.classifyChatError(0, error.message);
        assistantMessage.content = detail.message;
        assistantMessage.isError = true;
        assistantMessage.errorDetail = detail;
        this.recordChatSourceHealth(sentSourceId, Date.now() - startedAt, false);
      } finally {
        this.chatLoading = false;
        this.chatStreamController = null;
        this.chatMessages = [...this.chatMessages];
        this.syncActiveChatSession();
      }
    },

    async sendAssistantConversationMessage() {
      const input = this.chatInput.trim();
      const session = this.getActiveChatSession();
      const pendingImage = this.chatPendingImage || null;
      if ((!input && !pendingImage) || !session) return;

      this.ensureAgentRuntimeSessionDefaults(session);
      if (session.runtimePendingApprovals.length > 0) {
        this.showToast(this.t('agentRuntimeApprovalPending'), 'warning');
        return;
      }

      const shouldAutoScroll = this.shouldStickChatToBottom();
      const previewSuffix = pendingImage ? '\n[Image attached]' : '';
      this.chatMessages.push({
        role: 'user',
        content: `${input}${previewSuffix}`.trim() || '[Image attached]',
        attachments: pendingImage ? [{
          kind: 'image',
          name: pendingImage.name || 'image',
          mediaType: pendingImage.mediaType || '',
          previewUrl: pendingImage.previewUrl || pendingImage.imageUrl || ''
        }] : [],
        _origin: 'web'
      });
      this.chatInput = '';
      this.chatPendingImage = null;
      this.chatLoading = true;
      this.syncActiveChatSession();
      this.scrollChatToBottom(shouldAutoScroll);

      const inputParts = [];
      if (input) {
        inputParts.push({ type: 'text', text: input });
      }
      if (pendingImage?.imageUrl) {
        inputParts.push({
          type: 'input_image',
          image_url: pendingImage.imageUrl,
          ...(pendingImage.mediaType ? { media_type: pendingImage.mediaType } : {})
        });
      }

      try {
        const { ok, data, error } = await this.api('/api/chat/agent-message', {
          method: 'POST',
          body: JSON.stringify({
            sessionId: session.id,
            conversationId: String(session.originConversationId || ''),
            input,
            inputParts,
            provider: session.runtimeProvider || this.chatRuntimeProvider
          })
        });
        const result = data?.result;
        if (!ok || !result) {
          throw new Error(data?.error || error || this.t('requestFailed'));
        }

        if (
          result.type === 'command_error'
          || result.type === 'supervisor_status'
          || result.type === 'preference_saved'
          || result.type === 'assistant_mode_entered'
          || result.type === 'assistant_mode_exited'
          || result.type === 'assistant_response'
        ) {
          this.appendAgentRuntimeMessage(session.id, {
            kind: 'agent-status',
            content: result.message || this.t('requestFailed'),
            isError: result.type === 'command_error',
            pendingAction: result.pendingAction || null,
            assistantRunId: result.assistantRun?.id || '',
            observability: result.observability || null,
            runStatus: result.assistantRun?.status || ''
          });
          if (result.type === 'command_error') {
            this.showToast(result.message || this.t('requestFailed'), 'warning');
          }
        }

        if (result.type === 'assistant_run_accepted' && result.assistantRun?.id) {
          session.pendingAssistantRunId = result.assistantRun.id;
          this.connectAssistantRunTraceStream(result.assistantRun.id);
          this.appendAgentRuntimeMessage(session.id, {
            kind: 'agent-status',
            content: result.message || '',
            isError: false,
            assistantRunId: result.assistantRun.id,
            traceAnchor: true,
            runStatus: result.assistantRun.status || 'queued',
            observability: result.observability || null
          });
          this.stopAssistantRunPolling();
          this.pollAssistantRunUntilFinal(session.id, result.assistantRun.id);
        }

        if (result.session?.id) {
          session.runtimeSessionId = result.session.id;
          session.runtimeProvider = result.session.provider || this.chatRuntimeProvider;
          session.attachedRuntimeProvider = result.session.provider || this.chatRuntimeProvider;
          session.attachedRuntimeModel = result.session.model || '';
          session.runtimeStatus = result.session.status || 'running';
          this.connectAgentRuntimeStream(session);
        }
      } catch (error) {
        this.appendAgentRuntimeMessage(session.id, {
          kind: 'agent-status',
          content: error.message || this.t('requestFailed'),
          isError: true
        });
        this.showToast(error.message || this.t('requestFailed'), 'error');
      } finally {
        this.chatLoading = false;
        this.loadAgentRuntimeSessions();
        this.syncActiveChatSession();
      }
    },

    async handleAssistantImagePicked(event) {
      const file = event?.target?.files?.[0];
      if (!file) return;
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(reader.error || new Error('file read failed'));
          reader.readAsDataURL(file);
        });
        this.chatPendingImage = {
          name: file.name || 'image',
          mediaType: file.type || '',
          size: Number(file.size || 0),
          imageUrl: dataUrl,
          previewUrl: dataUrl
        };
        this.syncActiveChatSession();
      } catch (error) {
        this.showToast(error?.message || this.t('requestFailed'), 'error');
      } finally {
        if (event?.target) {
          event.target.value = '';
        }
      }
    },

    clearAssistantPendingImage() {
      this.chatPendingImage = null;
      this.syncActiveChatSession();
    },

    async sendAgentRuntimeMessage() {
      const input = this.chatInput.trim();
      const session = this.getActiveChatSession();
      if (!input || !session) return;

      this.ensureAgentRuntimeSessionDefaults(session);
      if (session.runtimePendingApprovals.length > 0) {
        this.showToast(this.t('agentRuntimeApprovalPending'), 'warning');
        return;
      }

      const shouldAutoScroll = this.shouldStickChatToBottom();
      this.chatMessages.push({ role: 'user', content: input, _origin: 'web' });
      this.chatInput = '';
      this.chatLoading = true;
      this.syncActiveChatSession();
      this.scrollChatToBottom(shouldAutoScroll);

      try {
        if (this.runtimeSessionConfigChanged(session)) {
          this.resetActiveRuntimeBinding({
            mode: 'agent-runtime',
            notice: this.buildRuntimeSessionRestartNotice(session)
          });
        }

        const pendingQuestionId = session.runtimePendingQuestion?.questionId || null;
        // Assistant (agent-runtime) lane: never send a model from the frontend.
        // The backend / bound CLI provider resolves its own appropriate model.
        // Sending `this.chatModel` here would be a category error — that state
        // belongs to the 模型对话 lane (chatSources models, e.g. 'gpt-5.2') and
        // would conflict with the actual runtime CLI's model namespace
        // (e.g. 'claude-sonnet-4-6' for claude-code).
        const agentRequestBody = {
          sessionId: session.id,
          input,
          provider: session.runtimeProvider || this.chatRuntimeProvider
        };
        const { ok, data, error } = await this.api('/api/chat/agent-message', {
          method: 'POST',
          body: JSON.stringify(agentRequestBody)
        });
        const result = data?.result;
        if (!ok || !result) {
          throw new Error(data?.error || error || this.t('requestFailed'));
        }

        if (result.type === 'question_answered' && pendingQuestionId) {
          this.updateAgentRuntimeMessage(
            session.id,
            (message) => message.kind === 'agent-question' && message.questionId === pendingQuestionId,
            (message) => ({
              ...message,
              questionStatus: result?.question?.status || 'answered'
            })
          );
          session.runtimePendingQuestion = null;
          session.runtimeStatus = 'running';
        }

        if (
          result.type === 'command_error'
          || result.type === 'supervisor_status'
          || result.type === 'preference_saved'
          || result.type === 'assistant_mode_entered'
          || result.type === 'assistant_mode_exited'
          || result.type === 'assistant_response'
        ) {
          this.appendAgentRuntimeMessage(session.id, {
            kind: 'agent-status',
            content: result.message || this.t('requestFailed'),
            isError: result.type === 'command_error',
            pendingAction: result.pendingAction || null,
            assistantRunId: result.assistantRun?.id || '',
            observability: result.observability || null,
            runStatus: result.assistantRun?.status || ''
          });
          if (result.type === 'command_error') {
            this.showToast(result.message || this.t('requestFailed'), 'warning');
          }
        }

        if (result.type === 'assistant_run_accepted' && result.assistantRun?.id) {
          session.pendingAssistantRunId = result.assistantRun.id;
          this.connectAssistantRunTraceStream(result.assistantRun.id);
          this.appendAgentRuntimeMessage(session.id, {
            kind: 'agent-status',
            content: result.message || '',
            isError: false,
            assistantRunId: result.assistantRun.id,
            traceAnchor: true,
            runStatus: result.assistantRun.status || 'queued',
            observability: result.observability || null
          });
          this.stopAssistantRunPolling();
          this.pollAssistantRunUntilFinal(session.id, result.assistantRun.id);
        }

        if (result.type === 'conversation_reset') {
          session.runtimeSessionId = null;
          session.runtimeStatus = 'ready';
          session.runtimePendingApprovals = [];
          session.runtimePendingQuestion = null;
          if (result.message) {
            this.appendAgentRuntimeMessage(session.id, {
              kind: 'agent-status',
              content: result.message,
              isError: false
            });
          }
        }

        if (result.type === 'approval_resolved' && session.runtimePendingApprovals.length > 0) {
          session.runtimePendingApprovals = [];
          session.runtimeStatus = session.runtimePendingQuestion ? 'waiting_user' : 'running';
          if (result.message) {
            this.appendAgentRuntimeMessage(session.id, {
              kind: 'agent-status',
              content: result.message,
              isError: false
            });
          }
        }

        if (result.session?.id) {
          session.runtimeSessionId = result.session.id;
          session.runtimeProvider = result.session.provider || this.chatRuntimeProvider;
          session.attachedRuntimeProvider = result.session.provider || this.chatRuntimeProvider;
          session.attachedRuntimeModel = result.session.model || (this.chatModel.trim() || '');
          session.runtimeStatus = result.session.status || 'running';
          session.model = this.chatModel.trim() || session.model;
          if (result.message && (result.type === 'runtime_started' || result.type === 'runtime_continued')) {
            this.appendAgentRuntimeMessage(session.id, {
              kind: 'agent-status',
              content: result.message,
              isError: false
            });
          }
          this.connectAgentRuntimeStream(session);
        }
      } catch (error) {
        this.appendAgentRuntimeMessage(session.id, {
          kind: 'agent-status',
          content: error.message || this.t('requestFailed'),
          isError: true
        });
        this.showToast(error.message || this.t('requestFailed'), 'error');
      } finally {
        this.chatLoading = false;
        this.loadAgentRuntimeSessions();
        this.syncActiveChatSession();
      }
    },

    async consumeChatStream(stream, assistantMessage) {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let seenDelta = false;
      let seenDone = false;
      const msgIndex = this.chatMessages.indexOf(assistantMessage);
      let stickToBottom = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';

        let needsUpdate = false;
        for (const chunk of chunks) {
          const payload = this.parseChatSseChunk(chunk);
          if (!payload) continue;

          if (payload.type === 'start') {
            assistantMessage.mappedModel = payload.mappedModel || null;
            assistantMessage.sourceLabel = payload.source?.label || assistantMessage.sourceLabel;
            assistantMessage.citations = Array.isArray(payload.assistant?.citations) ? payload.assistant.citations : [];
            needsUpdate = true;
          } else if (payload.type === 'delta') {
            seenDelta = true;
            assistantMessage.content += payload.text || '';
            needsUpdate = true;
          } else if (payload.type === 'done') {
            seenDone = true;
            assistantMessage.usage = payload.usage || null;
            assistantMessage.model = payload.model || assistantMessage.model;
            assistantMessage.mappedModel = payload.mappedModel || assistantMessage.mappedModel;
            assistantMessage.citations = Array.isArray(payload.citations) ? payload.citations : assistantMessage.citations;
            needsUpdate = true;
          } else if (payload.type === 'action_confirmation') {
            assistantMessage.pendingAction = payload.pendingAction || null;
            assistantMessage._confirming = false;
            needsUpdate = true;
          } else if (payload.type === 'error') {
            assistantMessage.content = payload.error || this.t('requestFailed');
            assistantMessage.isError = true;
            throw new Error(assistantMessage.content);
          }
        }

        if (needsUpdate && msgIndex >= 0) {
          stickToBottom = this.shouldStickChatToBottom();
          this.chatMessages[msgIndex] = { ...assistantMessage };
          this.chatMessages = [...this.chatMessages];
          this.scrollChatToBottom(stickToBottom);
        }
      }

      return { seenDelta, seenDone };
    },

    async fetchChatCompletionFallback(requestMessages, assistantMessage) {
      const { ok, data, error } = await this.api('/api/chat/complete', {
        method: 'POST',
        body: JSON.stringify({
          sourceId: this.chatSourceId,
          model: this.chatModel.trim() || 'gpt-5.2',
          messages: requestMessages,
          assistantMode: this.chatMode !== 'direct-chat' && this.chatAssistantMode === true,
          uiLang: this.lang
        })
      });

      if (ok && data?.reply) {
        assistantMessage.content = data.reply.content || '';
        assistantMessage.usage = data.reply.usage || null;
        assistantMessage.model = data.model || assistantMessage.model;
        assistantMessage.mappedModel = data.mappedModel || null;
        assistantMessage.sourceLabel = data.source?.label || assistantMessage.sourceLabel;
        assistantMessage.citations = Array.isArray(data.reply.citations) ? data.reply.citations : [];
        assistantMessage.pendingAction = data.reply.pendingAction || null;
        assistantMessage._confirming = false;
        assistantMessage.isError = false;
        this.chatMessages = [...this.chatMessages];
        this.scrollChatToBottom(true);
        return;
      }

      throw new Error(data?.error || error || this.t('requestFailed'));
    },

    parseChatSseChunk(chunk) {
      const lines = chunk.split('\n');
      let dataLine = '';
      for (const line of lines) {
        if (line.startsWith('data:')) {
          dataLine += line.slice(5).trim();
        }
      }
      if (!dataLine) return null;
      try {
        return JSON.parse(dataLine);
      } catch {
        return null;
      }
    },

    chatSourceLabel(sourceId) {
      return this.chatSources.find((source) => source.id === sourceId)?.label || sourceId;
    },

    agentRuntimeStatusLabel(session = this.getActiveChatSession()) {
      const status = session?.runtimeStatus || '';
      if (status === 'running') return this.t('agentRuntimeStatusRunning');
      if (status === 'waiting_user') return this.t('agentRuntimeStatusWaitingUser');
      if (status === 'waiting_approval') return this.t('agentRuntimeStatusWaitingApproval');
      if (status === 'ready') return this.t('agentRuntimeStatusReady');
      if (status === 'failed') return this.t('failedLabel');
      return this.t('agentRuntimeStatusIdle');
    },

    async respondAgentRuntimeApproval(message, decision) {
      const session = this.getActiveChatSession();
      if (!session?.runtimeSessionId || !message?.approvalId) return;
      message._approving = true;
      this.chatMessages = [...this.chatMessages];

      const { ok, data, error } = await this.api(`/api/agent-runtimes/sessions/${encodeURIComponent(session.runtimeSessionId)}/approval`, {
        method: 'POST',
        body: JSON.stringify({
          approvalId: message.approvalId,
          decision
        })
      });

      message._approving = false;
      if (ok && data?.approval) {
        message.approvalStatus = data.approval.status || decision;
        session.runtimePendingApprovals = session.runtimePendingApprovals.filter((item) => item.approvalId !== message.approvalId);
        session.runtimeStatus = session.runtimePendingApprovals.length > 0
          ? 'waiting_approval'
          : (session.runtimePendingQuestion ? 'waiting_user' : 'running');
        this.chatMessages = [...this.chatMessages];
        this.syncActiveChatSession();
        this.loadAgentRuntimeSessions();
        return;
      }

      this.showToast(data?.error || error || this.t('requestFailed'), 'error');
      this.chatMessages = [...this.chatMessages];
    },

    async cancelAssistantClarification(clarificationId) {
      const id = String(clarificationId || '').trim();
      if (!id) return;
      const { ok, error } = await this.api(`/api/assistant/clarifications/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      if (!ok) {
        this.showToast(this.t('assistantMindClarificationCancelFailed', error || ''), 'error');
        return;
      }
      this.assistantMind = { ...this.assistantMind, pendingClarification: null };
      this.showToast(this.t('assistantMindClarificationCancelled'), 'success');
    },

    async submitAssistantAlias(workspaceRef) {
      const alias = String(this.assistantAliasInput || '').trim();
      if (!alias) {
        this.showToast(this.t('assistantMindAliasEmpty'), 'warning');
        return;
      }
      const { ok, error } = await this.api('/api/assistant/workspaces/aliases', {
        method: 'POST',
        body: JSON.stringify({ workspaceRef, alias })
      });
      if (!ok) {
        this.showToast(this.t('assistantMindAliasSaveFailed', error || ''), 'error');
        return;
      }
      this.assistantAliasInput = '';
      this.assistantAliasEditingFor = '';
      await this.loadAssistantMind();
    },

    async loadAssistantMind() {
      this.assistantMindLoading = true;
      try {
        const wsRes = await this.api('/api/assistant/workspace-context');
        const wsKnownCwds = wsRes.ok ? (wsRes.data?.knownCwds || []) : [];
        let pendingClarification = null;
        let pendingQuestions = [];
        let pendingApprovals = [];
        let recentTasks = [];
        let relevantArtifacts = [];
        let recentChatTurns = [];
        const session = this.getActiveChatSession();
        let conversationId = '';
        if (session?.id) {
          const cs = await this.api(`/api/chat/sessions/${encodeURIComponent(session.id)}`);
          conversationId = cs.ok ? String(cs.data?.session?.conversationId || '') : '';
        }

        if (conversationId) {
          const convRes = await this.api(`/api/assistant/conversations/${encodeURIComponent(conversationId)}`);
          if (convRes.ok && convRes.data) {
            pendingClarification = convRes.data.pendingClarification || null;
            pendingQuestions = Array.isArray(convRes.data.pendingQuestions) ? convRes.data.pendingQuestions : [];
            pendingApprovals = Array.isArray(convRes.data.pendingApprovals) ? convRes.data.pendingApprovals : [];
            relevantArtifacts = Array.isArray(convRes.data.relevantArtifacts) ? convRes.data.relevantArtifacts : [];
            recentChatTurns = Array.isArray(convRes.data.recentChatTurns) ? convRes.data.recentChatTurns : [];
          }
          const taskRes = await this.api(`/api/assistant/tasks?conversationId=${encodeURIComponent(conversationId)}&limit=8`);
          if (taskRes.ok && Array.isArray(taskRes.data?.tasks)) {
            recentTasks = taskRes.data.tasks.map((t) => ({
              id: t.id || t.taskId,
              title: t.task?.title || t.title || '',
              status: t.state || t.task?.status || '',
              updatedAt: t.updatedAt || ''
            }));
          }
        }

        this.assistantMind = {
          pendingClarification,
          pendingQuestions,
          pendingApprovals,
          knownCwds: wsKnownCwds,
          recentTasks,
          relevantArtifacts,
          recentChatTurns
        };
        this.assistantMindSummary = {
          knownCwdCount: wsKnownCwds.length
        };
      } catch (err) {
        this.showToast(this.t('assistantMindLoadFailed', err.message || err), 'error');
      } finally {
        this.assistantMindLoading = false;
      }
    },

    assistantMindArtifactPreview(artifact) {
      if (!artifact || typeof artifact !== 'object') return '-';
      return artifact.summary
        || artifact.title
        || artifact.contentText
        || artifact.path
        || artifact.imageUrl
        || '-';
    },

    assistantMindRecentTurnPreview(turn) {
      if (!turn || typeof turn !== 'object') return '-';
      const text = String(turn.text || '').trim();
      if (text) return text;
      const parts = Array.isArray(turn.parts) ? turn.parts : [];
      if (parts.some((part) => part?.type === 'input_image')) {
        return '[image]';
      }
      return '-';
    },

    findLocalChatSessionByRuntimeId(runtimeSessionId) {
      return this.chatSessions.find((item) => item.runtimeSessionId === runtimeSessionId) || null;
    },

    ensureChatSessionForRuntime(runtimeSession) {
      const existing = this.findLocalChatSessionByRuntimeId(runtimeSession.id);
      if (existing) {
        existing.mode = 'agent-runtime';
        existing.runtimeProvider = runtimeSession.provider;
        existing.runtimeStatus = runtimeSession.status || existing.runtimeStatus || '';
        existing.model = runtimeSession.model || existing.model || '';
        existing.attachedRuntimeProvider = runtimeSession.provider || existing.attachedRuntimeProvider || '';
        existing.attachedRuntimeModel = runtimeSession.model || existing.attachedRuntimeModel || '';
        existing.title = runtimeSession.title || existing.title || this.chatSessionTitle(existing);
        return existing;
      }

      const sessionId = 'chat_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const next = {
        id: sessionId,
        title: runtimeSession.title || this.t('newChat'),
        mode: 'agent-runtime',
        sourceId: '',
        runtimeProvider: runtimeSession.provider || 'codex',
        runtimeSessionId: runtimeSession.id,
        attachedRuntimeProvider: runtimeSession.provider || 'codex',
        attachedRuntimeModel: runtimeSession.model || '',
        runtimeStatus: runtimeSession.status || '',
        runtimeLastEventSeq: 0,
        runtimePendingQuestion: null,
        runtimePendingApprovals: [],
        runtimeUnread: false,
        model: runtimeSession.model || '',
        assistantMode: true,
        systemPrompt: '',
        messages: [],
        updatedAt: runtimeSession.updatedAt || new Date().toISOString()
      };
      this.chatSessions.unshift(next);
      this.persistChatSessions();
      return next;
    },

    openAgentRuntimeMonitorSession(runtimeSession) {
      if (!runtimeSession?.id) return;
      const session = this.ensureChatSessionForRuntime(runtimeSession);
      this.openChatSession(session.id);
      this.chatHistoryOpen = false;
    },

    async cancelAgentRuntimeTask(runtimeSessionId) {
      if (!runtimeSessionId) return;
      const { ok, data, error } = await this.api(`/api/agent-runtimes/sessions/${encodeURIComponent(runtimeSessionId)}/cancel`, {
        method: 'POST'
      });

      if (!ok) {
        this.showToast(data?.error || error || this.t('requestFailed'), 'error');
        return;
      }

      const localSession = this.findLocalChatSessionByRuntimeId(runtimeSessionId);
      if (localSession) {
        localSession.runtimeStatus = data?.session?.status || 'cancelled';
        this.syncActiveChatSession();
      }
      await this.loadAgentRuntimeSessions();
      this.showToast(this.t('agentRuntimeCancelled'), 'success');
    },

    formatChatCitation(citation) {
      if (!citation) return '';
      if (Array.isArray(citation.titlePath) && citation.titlePath.length > 0) {
        return citation.titlePath.join(' / ');
      }
      return citation.title || '';
    },

    async confirmChatPendingAction(message) {
      if (!message?.pendingAction?.confirmToken || message._confirming) return;
      message._confirming = true;
      this.chatMessages = [...this.chatMessages];

      const { ok, data, error } = await this.api('/api/chat/tool-confirm', {
        method: 'POST',
        body: JSON.stringify({
          confirmToken: message.pendingAction.confirmToken
        })
      });

      message._confirming = false;

      if (ok && data?.success) {
        const suffix = data.configPath ? `\n${data.configPath}` : '';
        const resultText = data.result || data.routeResult?.message || 'Confirmed.';
        message.content = `${message.content}\n\n${resultText}${suffix}`.trim();
        message.pendingAction = null;
        this.chatMessages = [...this.chatMessages];
        this.syncActiveChatSession();
        this.scrollChatToBottom(true);
        return;
      }

      const errorMessage = data?.error || error || this.t('requestFailed');
      this.showToast(errorMessage, 'error');
      this.chatMessages = [...this.chatMessages];
    },

    dismissChatPendingAction(message) {
      if (!message) return;
      message.pendingAction = null;
      this.chatMessages = [...this.chatMessages];
      this.syncActiveChatSession();
      this.scrollChatToBottom(true);
    },

    toggleChatHistory() {
      this.chatHistoryOpen = !this.chatHistoryOpen;
      if (this.chatHistoryOpen && typeof this.loadChannelConversations === 'function') {
        this.loadChannelConversations({ silent: true });
      }
    },

    openHistoryCard(card) {
      if (!card) return;
      if (card.type === 'local' && card.raw?.id) {
        this.openChatSession(card.raw.id);
        this.chatHistoryOpen = false;
        return;
      }
      if (card.type === 'remote') {
        this.openRemoteConversation(card);
        this.chatHistoryOpen = false;
      }
    },

    toggleSystemPrompt() {
      this.chatSystemPromptOpen = !this.chatSystemPromptOpen;
    }
  };
}
