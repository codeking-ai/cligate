export function createMcpPageModule() {
  return {
    mcpLoading: false,
    mcpSaving: false,
    mcpServers: [],
    selectedMcpServerName: '',
    mcpTools: [],
    mcpResources: [],
    mcpCapabilityTab: 'tools',
    mcpForm: {
      name: '',
      enabled: false,
      transport: 'stdio',
      command: '',
      argsText: '',
      cwd: '',
      envText: '{}',
      url: '',
      bearerTokenEnvVar: '',
      headersText: '{}',
      timeoutMs: 30000,
      approvalMode: 'ask'
    },

    get selectedMcpServer() {
      return this.mcpServers.find((entry) => entry.name === this.selectedMcpServerName) || null;
    },

    async loadMcpServers({ preserveSelection = true } = {}) {
      this.mcpLoading = true;
      const { ok, data, error } = await this.api('/api/assistant/mcp/servers');
      this.mcpLoading = false;
      if (!ok || !data?.success) {
        this.showToast(data?.error || error || this.t('mcpLoadFailed'), 'error');
        return;
      }
      this.mcpServers = Array.isArray(data.servers) ? data.servers : [];
      const selected = preserveSelection ? this.selectedMcpServerName : '';
      const next = selected && this.mcpServers.some((entry) => entry.name === selected)
        ? selected
        : (this.mcpServers[0]?.name || '');
      if (next) {
        this.selectMcpServer(next);
      } else {
        this.resetMcpForm();
      }
    },

    resetMcpForm() {
      this.selectedMcpServerName = '';
      this.mcpTools = [];
      this.mcpResources = [];
      this.mcpCapabilityTab = 'tools';
      this.mcpForm = {
        name: '',
        enabled: false,
        transport: 'stdio',
        command: '',
        argsText: '',
        cwd: '',
        envText: '{}',
        url: '',
        bearerTokenEnvVar: '',
        headersText: '{}',
        timeoutMs: 30000,
        approvalMode: 'ask'
      };
    },

    selectMcpServer(name) {
      const server = this.mcpServers.find((entry) => entry.name === name);
      if (!server) {
        this.resetMcpForm();
        return;
      }
      this.selectedMcpServerName = server.name;
      this.mcpForm = {
        name: server.name || '',
        enabled: server.enabled === true,
        transport: server.transport || 'stdio',
        command: server.command || '',
        argsText: Array.isArray(server.args) ? server.args.join('\n') : '',
        cwd: server.cwd || '',
        envText: JSON.stringify(server.env || {}, null, 2),
        url: server.url || '',
        bearerTokenEnvVar: server.bearerTokenEnvVar || '',
        headersText: JSON.stringify(server.headers || {}, null, 2),
        timeoutMs: Number(server.timeoutMs || 30000),
        approvalMode: server.approvalMode || 'ask'
      };
      this.loadMcpServerTools(server.name);
      this.loadMcpServerResources(server.name);
      this.mcpCapabilityTab = 'tools';
    },

    parseMcpArgs(text = '') {
      const trimmed = String(text || '').trim();
      if (!trimmed) return [];
      if (trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) throw new Error(this.t('mcpArgsInvalid'));
        return parsed.map((entry) => String(entry));
      }
      return trimmed.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    },

    setMcpTransport(transport) {
      this.mcpForm.transport = transport === 'http' ? 'http' : 'stdio';
    },

    parseMcpJsonObject(text = '{}', invalidMessage = '') {
      const trimmed = String(text || '').trim();
      if (!trimmed) return {};
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(invalidMessage || this.t('invalidJsonBody'));
      }
      return parsed;
    },

    buildMcpPayload() {
      const transport = this.mcpForm.transport === 'http' ? 'http' : 'stdio';
      const timeoutMs = Number(this.mcpForm.timeoutMs || 30000);
      const payload = {
        name: this.mcpForm.name.trim(),
        enabled: this.mcpForm.enabled === true,
        transport,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 30000,
        approvalMode: this.mcpForm.approvalMode || 'ask'
      };
      if (transport === 'stdio') {
        payload.command = this.mcpForm.command.trim();
        payload.args = this.parseMcpArgs(this.mcpForm.argsText);
        payload.cwd = this.mcpForm.cwd.trim();
        payload.env = this.parseMcpJsonObject(this.mcpForm.envText, this.t('mcpEnvInvalid'));
        payload.url = '';
        payload.bearerTokenEnvVar = '';
        payload.headers = {};
      } else {
        payload.command = '';
        payload.args = [];
        payload.cwd = '';
        payload.env = {};
        payload.url = this.mcpForm.url.trim();
        payload.bearerTokenEnvVar = this.mcpForm.bearerTokenEnvVar.trim();
        payload.headers = this.parseMcpJsonObject(this.mcpForm.headersText, this.t('mcpHeadersInvalid'));
      }
      return payload;
    },

    validateMcpPayload(payload) {
      if (!payload.name) {
        return this.t('mcpNameRequired');
      }
      if (payload.transport === 'stdio' && !payload.command) {
        return this.t('mcpCommandRequired');
      }
      if (payload.transport === 'http') {
        if (!payload.url) {
          return this.t('mcpUrlRequired');
        }
        try {
          const parsed = new URL(payload.url);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            return this.t('mcpUrlInvalid');
          }
        } catch {
          return this.t('mcpUrlInvalid');
        }
      }
      if (payload.timeoutMs < 1000 || payload.timeoutMs > 120000) {
        return this.t('mcpTimeoutInvalid');
      }
      return '';
    },

    async saveMcpServer() {
      let payload;
      try {
        payload = this.buildMcpPayload();
      } catch (error) {
        this.showToast(error.message || this.t('invalidJsonBody'), 'error');
        return;
      }
      const validationError = this.validateMcpPayload(payload);
      if (validationError) {
        this.showToast(validationError, 'error');
        return;
      }
      this.mcpSaving = true;
      const endpoint = this.selectedMcpServerName
        ? `/api/assistant/mcp/servers/${encodeURIComponent(this.selectedMcpServerName)}`
        : '/api/assistant/mcp/servers';
      const method = this.selectedMcpServerName ? 'PUT' : 'POST';
      const { ok, data, error } = await this.api(endpoint, {
        method,
        body: JSON.stringify(payload)
      });
      this.mcpSaving = false;
      if (!ok || !data?.success) {
        this.showToast(data?.error || error || this.t('mcpSaveFailed'), 'error');
        return;
      }
      this.selectedMcpServerName = data.server?.name || payload.name;
      this.showToast(this.t('mcpSaved'), 'success');
      await this.loadMcpServers();
    },

    async toggleMcpServer(server) {
      if (!server?.name) return;
      const { ok, data, error } = await this.api(`/api/assistant/mcp/servers/${encodeURIComponent(server.name)}/enabled`, {
        method: 'POST',
        body: JSON.stringify({ enabled: server.enabled !== true })
      });
      if (!ok || !data?.success) {
        this.showToast(data?.error || error || this.t('mcpSaveFailed'), 'error');
        return;
      }
      this.selectedMcpServerName = server.name;
      await this.loadMcpServers();
    },

    async reloadMcpServer(server = this.selectedMcpServer) {
      if (!server?.name) return;
      const { ok, data, error } = await this.api(`/api/assistant/mcp/servers/${encodeURIComponent(server.name)}/reload`, {
        method: 'POST'
      });
      if (!ok || !data?.success) {
        this.showToast(data?.error || error || this.t('mcpReloadFailed'), 'error');
        return;
      }
      this.showToast(this.t('mcpReloaded'), 'success');
      await this.loadMcpServers();
    },

    async deleteMcpServer(server = this.selectedMcpServer) {
      if (!server?.name) return;
      if (!window.confirm(`${this.t('mcpDeleteConfirm')} ${server.name}?`)) return;
      const { ok, data, error } = await this.api(`/api/assistant/mcp/servers/${encodeURIComponent(server.name)}`, {
        method: 'DELETE'
      });
      if (!ok || !data?.success) {
        this.showToast(data?.error || error || this.t('deleteFailed'), 'error');
        return;
      }
      this.showToast(this.t('mcpDeleted'), 'success');
      this.resetMcpForm();
      await this.loadMcpServers({ preserveSelection: false });
    },

    async loadMcpServerTools(name = this.selectedMcpServerName, { refresh = false } = {}) {
      if (!name) return;
      const suffix = refresh ? '?refresh=1' : '';
      const { ok, data, error } = await this.api(`/api/assistant/mcp/servers/${encodeURIComponent(name)}/tools${suffix}`);
      if (!ok || !data?.success) {
        if (refresh) {
          this.showToast(data?.error || error || this.t('mcpLoadFailed'), 'error');
        }
        this.mcpTools = [];
        return;
      }
      this.mcpTools = Array.isArray(data.tools) ? data.tools : [];
    },

    async loadMcpServerResources(name = this.selectedMcpServerName) {
      if (!name) return;
      const { ok, data } = await this.api(`/api/assistant/mcp/servers/${encodeURIComponent(name)}/resources`);
      this.mcpResources = ok && data?.success && Array.isArray(data.resources) ? data.resources : [];
    },

    mcpStatusClass(server) {
      const status = String(server?.status || '');
      if (status === 'connected') return 'bg-neon-green/10 text-neon-green border-neon-green/30';
      if (status === 'disabled') return 'bg-space-800/60 text-gray-400 border-space-border/50';
      if (status === 'failed') return 'bg-red-500/10 text-red-300 border-red-500/30';
      return 'bg-amber-500/10 text-amber-300 border-amber-500/30';
    },

    mcpTransportLabel(transport = '') {
      return transport === 'http' ? this.t('mcpTransportHttp') : this.t('mcpTransportStdio');
    },

    mcpServerSummary(server = {}) {
      if (!server) return '-';
      const endpoint = server.transport === 'http'
        ? server.url
        : [server.command, ...(Array.isArray(server.args) ? server.args : [])].filter(Boolean).join(' ');
      return endpoint || '-';
    },

    mcpToolSchemaText(tool) {
      try {
        return JSON.stringify(tool?.inputSchema || {}, null, 2);
      } catch {
        return '{}';
      }
    }
  };
}

export default createMcpPageModule;
