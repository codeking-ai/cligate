import desktopAgentManager from './manager.js';
import { getDesktopAgentSettings, setDesktopAgentSettings } from './settings.js';
import { ensureDesktopAgentToken } from './token-store.js';
import DesktopAgentHttpClient from './http-client.js';

function normalizeRegion(region) {
  if (!region) return null;
  if (Array.isArray(region)) {
    if (region.length !== 4) return null;
    const [x, y, w, h] = region.map((value) => Number(value) || 0);
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }
  if (typeof region === 'object') {
    const x = Number(region.x) || 0;
    const y = Number(region.y) || 0;
    const w = Number(region.w ?? region.width) || 0;
    const h = Number(region.h ?? region.height) || 0;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }
  return null;
}

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
      let region = normalizeRegion(spec.region);
      // LLMs routinely emit `region: {x:0,y:0,w:0,h:0}` because the JSON schema
      // marks region as optional-but-shaped. That used to silently fall through
      // to "screenshot the whole 2560x1600 desktop", which compressed the actual
      // target (a small installer window) into ~120px and made the model miss
      // its click target by 10-20 screen pixels. Treat any window-targeted call
      // without a real region as "give me the window's BoundingRectangle".
      const hasWindowSpec = (Number.isFinite(spec.windowHwnd) && spec.windowHwnd > 0)
        || (typeof spec.windowTitle === 'string' && spec.windowTitle.trim() !== '')
        || (typeof spec.windowClass === 'string' && spec.windowClass.trim() !== '');
      if (!region && hasWindowSpec) {
        try {
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
            const [x, y, w, h] = bbox.map((value) => Number(value) || 0);
            if (w > 0 && h > 0) {
              region = { x, y, w, h };
            }
          }
        } catch {
          // Fall through: ui/find may not see this window (e.g. ATL custom
          // installer with no UIA surface). A full-screen capture is still
          // better than failing the call.
        }
      }
      const result = await this.client.screenshot({
        inline: spec.inline !== false,
        inline_target: spec.inlineTarget || 'preview',
        preview_width: spec.previewWidth || 1280,
        ...(region ? { region } : {})
      });
      // Tell the LLM, in the result it actually sees, whether the preview is
      // *windowed* or full-screen. Otherwise it cannot tell which coordinate
      // space to feed back to desktop_click_at.
      if (result && typeof result === 'object' && region) {
        result.window_region = region;
        result.window_region_source = hasWindowSpec ? 'window_bbox' : 'caller_region';
      }
      return result;
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

  async clickAt(input = {}) {
    await this.ensureReady();
    return this.runExclusive(input, () => this.client.clickAt(input));
  }

  async cursorInfo() {
    await this.ensureReady();
    return this.client.cursorInfo();
  }

  async findText(input = {}) {
    await this.ensureReady();
    return this.runExclusive(input, async () => {
      const spec = { ...input };
      let region = normalizeRegion(spec.region);
      const hasWindowSpec = (Number.isFinite(spec.windowHwnd) && spec.windowHwnd > 0)
        || (typeof spec.windowTitle === 'string' && spec.windowTitle.trim() !== '')
        || (typeof spec.windowClass === 'string' && spec.windowClass.trim() !== '');
      // Cropping to the window before OCR is a big quality win: OCR over the
      // whole 2560x1600 desktop wastes ~3 seconds and surfaces every dashboard
      // / browser tab / taskbar tooltip as a "match", whereas the cropped path
      // typically returns in <500 ms with only window-local text.
      if (!region && hasWindowSpec) {
        try {
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
            const [x, y, w, h] = bbox.map((value) => Number(value) || 0);
            if (w > 0 && h > 0) {
              region = { x, y, w, h };
            }
          }
        } catch {
          // ATL/DirectUI installers won't be in the UIA tree — full-screen
          // OCR is the only option in that case.
        }
      }
      return this.client.findText({
        ...spec,
        ...(region ? { region } : {})
      });
    });
  }

  async waitChange(input = {}) {
    await this.ensureReady();
    return this.runExclusive(input, async () => {
      const spec = { ...input };
      let region = normalizeRegion(spec.region);
      const hasWindowSpec = (Number.isFinite(spec.windowHwnd) && spec.windowHwnd > 0)
        || (typeof spec.windowTitle === 'string' && spec.windowTitle.trim() !== '')
        || (typeof spec.windowClass === 'string' && spec.windowClass.trim() !== '');
      // Same trick as captureWindow: a wait_change that watches the whole desktop
      // will pick up clock ticks, taskbar animations, notification toasts, etc.
      // and falsely report "changed=true" even when the click did nothing to the
      // target window. Resolve the window bbox up front so we sample only there.
      if (!region && hasWindowSpec) {
        try {
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
            const [x, y, w, h] = bbox.map((value) => Number(value) || 0);
            if (w > 0 && h > 0) {
              region = { x, y, w, h };
            }
          }
        } catch {
          // Fall through — full screen wait_change is still useful if the
          // window cannot be resolved (e.g. transient splash screens).
        }
      }
      return this.client.waitChange({
        ...spec,
        ...(region ? { region } : {})
      });
    });
  }

  async moveMouse(input = {}) {
    await this.ensureReady();
    return this.runExclusive(input, () => this.client.moveMouse(input));
  }

  async scroll(input = {}) {
    await this.ensureReady();
    return this.runExclusive(input, () => this.client.scroll(input));
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
