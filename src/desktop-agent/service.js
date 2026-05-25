import desktopAgentManager from './manager.js';
import { getDesktopAgentSettings, setDesktopAgentSettings } from './settings.js';
import { ensureDesktopAgentToken } from './token-store.js';
import DesktopAgentHttpClient from './http-client.js';

export class DesktopAgentService {
  constructor({
    manager = desktopAgentManager,
    client = new DesktopAgentHttpClient()
  } = {}) {
    this.manager = manager;
    this.client = client;
    this.activeLeaseId = '';
    this.queue = Promise.resolve();
  }

  getSettings() {
    return getDesktopAgentSettings();
  }

  updateSettings(patch = {}) {
    return setDesktopAgentSettings(patch);
  }

  async ensureReady() {
    const settings = this.getSettings();
    if (settings.enabled !== true) {
      const error = new Error('desktop agent is disabled');
      error.code = 'DESKTOP_AGENT_DISABLED';
      throw error;
    }

    let status = this.manager.getStatus();
    if (!status.running) {
      await this.start();
      status = this.manager.getStatus();
    }

    let lastError = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await this.client.health();
        return true;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    throw lastError || new Error('desktop agent failed to become ready');
  }

  async getStatus() {
    const settings = this.getSettings();
    const managerStatus = this.manager.getStatus();
    let health = null;
    try {
      health = await this.client.health();
    } catch (error) {
      health = {
        ok: false,
        error: String(error?.message || error || 'desktop_agent_unreachable'),
        code: String(error?.code || '')
      };
    }
    return {
      success: true,
      settings,
      manager: managerStatus,
      health,
      lease: this.getLeaseStatus()
    };
  }

  async start() {
    ensureDesktopAgentToken();
    const manager = await this.manager.start();
    return {
      success: true,
      manager
    };
  }

  async stop() {
    const manager = this.manager.stop();
    return {
      success: true,
      manager
    };
  }

  async health() {
    await this.ensureReady();
    return this.client.health();
  }

  async windows(input = {}) {
    await this.ensureReady();
    return this.client.windows(input);
  }

  async launchApp(input = {}) {
    await this.ensureReady();
    return this.runExclusive(input, () => this.client.launch(input));
  }

  async captureWindow(input = {}) {
    await this.ensureReady();
    return this.runExclusive(input, async () => {
      const spec = { ...input };
      let region = spec.region;
      if (!region) {
        const findSpec = Number.isFinite(spec.windowHwnd) && spec.windowHwnd > 0
          ? { window_hwnd: Number(spec.windowHwnd) }
          : {
              window_title: spec.windowTitle,
              window_class: spec.windowClass,
              window_match: spec.windowMatch
            };
        const found = await this.client.uiFind(findSpec);
        const bbox = found?.window?.bbox || found?.control?.bbox;
        if (Array.isArray(bbox) && bbox.length === 4) {
          region = {
            x: bbox[0],
            y: bbox[1],
            w: bbox[2],
            h: bbox[3]
          };
        }
      }
      return this.client.screenshot({
        inline: spec.inline !== false,
        inline_target: spec.inlineTarget || 'preview',
        preview_width: spec.previewWidth || 1280,
        ...(region ? { region } : {})
      });
    });
  }

  async focusWindow(input = {}) {
    await this.ensureReady();
    return this.runExclusive(input, () => this.client.focusWindow(input));
  }

  async findControl(input = {}) {
    await this.ensureReady();
    return this.client.uiFind(input);
  }

  async findAllControls(input = {}) {
    await this.ensureReady();
    return this.client.uiFindAll(input);
  }

  async actOnControl(input = {}) {
    await this.ensureReady();
    return this.runExclusive(input, () => this.client.uiAct(input));
  }

  async waitForControl(input = {}) {
    await this.ensureReady();
    return this.client.uiWait(input);
  }

  async pressKey(input = {}) {
    await this.ensureReady();
    return this.runExclusive(input, () => this.client.pressKey(input));
  }

  async hotkey(input = {}) {
    await this.ensureReady();
    return this.runExclusive(input, () => this.client.hotkey(input));
  }

  async typeText(input = {}) {
    await this.ensureReady();
    return this.runExclusive(input, () => this.client.typeText(input));
  }

  getLeaseStatus() {
    return {
      activeLeaseId: this.activeLeaseId || '',
      busy: this.activeLeaseId !== ''
    };
  }

  async runExclusive(input = {}, task) {
    const requestedLeaseId = String(input?.leaseId || input?.lease_id || '').trim();
    const leaseId = requestedLeaseId || 'desktop-lease';
    if (this.activeLeaseId && this.activeLeaseId !== leaseId) {
      const error = new Error(`desktop lease busy: ${this.activeLeaseId}`);
      error.code = 'LEASE_CONFLICT';
      throw error;
    }

    const run = async () => {
      this.activeLeaseId = leaseId;
      try {
        return await task();
      } finally {
        this.activeLeaseId = '';
      }
    };

    const next = this.queue.then(run, run);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

const desktopAgentService = new DesktopAgentService();

export { desktopAgentService };
export default desktopAgentService;
