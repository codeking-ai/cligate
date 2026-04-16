import { logger } from '../utils/logger.js';
import { getServerSettings, setServerSettings } from '../server-settings.js';
import agentChannelRegistry from './registry.js';
import agentChannelRouter from './router.js';
import agentChannelOutboundDispatcher from './outbound-dispatcher.js';

export class AgentChannelManager {
  constructor({
    registry = agentChannelRegistry,
    router = agentChannelRouter,
    outboundDispatcher = agentChannelOutboundDispatcher,
    settingsProvider = getServerSettings,
    settingsWriter = setServerSettings
  } = {}) {
    this.registry = registry;
    this.router = router;
    this.outboundDispatcher = outboundDispatcher;
    this.settingsProvider = settingsProvider;
    this.settingsWriter = settingsWriter;
    this.providerStates = new Map();
    this.started = false;
  }

  getSettings() {
    return this.settingsProvider().channels || {};
  }

  updateChannelSettings(channelId, patch = {}) {
    const settings = this.settingsProvider();
    const currentChannels = settings.channels || {};
    const currentChannel = currentChannels[channelId] || {};
    const next = this.settingsWriter({
      channels: {
        ...currentChannels,
        [channelId]: {
          ...currentChannel,
          ...patch
        }
      }
    });
    return next.channels?.[channelId] || null;
  }

  getProviderStatuses() {
    return this.registry.list().map((provider) => ({
      ...provider,
      status: this.providerStates.get(provider.id) || {
        running: false,
        enabled: false,
        mode: provider.capabilities?.mode || 'disabled',
        lastError: null,
        lastStartedAt: null
      }
    }));
  }

  getStatus(providerId) {
    return this.getProviderStatuses().find((entry) => entry.id === providerId) || null;
  }

  async start() {
    if (this.started) {
      return this.getProviderStatuses();
    }

    this.outboundDispatcher.start();
    this.started = true;
    await this.refresh();
    return this.getProviderStatuses();
  }

  async stop() {
    const providers = this.registry.list();
    for (const entry of providers) {
      const provider = this.registry.get(entry.id);
      try {
        await provider?.stop?.();
      } catch (error) {
        logger.warn(`[AgentChannel] Failed to stop ${entry.id}: ${error.message}`);
      }
      this.providerStates.set(entry.id, {
        running: false,
        enabled: false,
        mode: entry.capabilities?.mode || 'disabled',
        lastError: null,
        lastStartedAt: null
      });
    }
    this.outboundDispatcher.stop();
    this.started = false;
  }

  async refresh() {
    const channels = this.getSettings();
    for (const entry of this.registry.list()) {
      await this._refreshProvider(entry.id, channels[entry.id] || {});
    }
    return this.getProviderStatuses();
  }

  async _refreshProvider(providerId, settings) {
    const provider = this.registry.get(providerId);
    if (!provider) {
      return;
    }

    try {
      await provider.stop?.();
    } catch (error) {
      logger.warn(`[AgentChannel] Failed to stop ${providerId} before refresh: ${error.message}`);
    }

    if (settings.enabled !== true) {
      this.providerStates.set(providerId, {
        running: false,
        enabled: false,
        mode: settings.mode || provider.capabilities?.mode || 'disabled',
        lastError: null,
        lastStartedAt: null
      });
      return;
    }

    try {
      const result = await provider.start({
        settings,
        router: this.router,
        logger
      });

      this.providerStates.set(providerId, {
        running: result?.started === true,
        enabled: true,
        mode: settings.mode || provider.capabilities?.mode || 'unknown',
        lastError: result?.started === true ? null : (result?.reason || null),
        lastStartedAt: result?.started === true ? new Date().toISOString() : null
      });
    } catch (error) {
      logger.error(`[AgentChannel] Failed to start ${providerId}: ${error.message}`);
      this.providerStates.set(providerId, {
        running: false,
        enabled: true,
        mode: settings.mode || provider.capabilities?.mode || 'unknown',
        lastError: error.message,
        lastStartedAt: null
      });
    }
  }
}

export const agentChannelManager = new AgentChannelManager();

export default agentChannelManager;
