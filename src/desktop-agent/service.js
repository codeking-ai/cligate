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

function hasWindowSpec(input = {}) {
  return (Number.isFinite(input.windowHwnd) && input.windowHwnd > 0)
    || (typeof input.windowTitle === 'string' && input.windowTitle.trim() !== '')
    || (typeof input.windowClass === 'string' && input.windowClass.trim() !== '');
}

async function resolveWindowRegion(client, input = {}) {
  if (!hasWindowSpec(input)) return null;
  try {
    const findSpec = Number.isFinite(input.windowHwnd) && input.windowHwnd > 0
      ? { window_hwnd: Number(input.windowHwnd) }
      : {
          window_title: input.windowTitle,
          window_class: input.windowClass,
          window_match: input.windowMatch
        };
    const found = await client.uiFind(findSpec);
    const bbox = found?.window?.bbox || found?.control?.bbox;
    if (Array.isArray(bbox) && bbox.length === 4) {
      const [x, y, w, h] = bbox.map((value) => Number(value) || 0);
      if (w > 0 && h > 0) {
        return { x, y, w, h };
      }
    }
  } catch {
    return null;
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
      const windowSpecified = hasWindowSpec(spec);
      if (!region && windowSpecified) {
        region = await resolveWindowRegion(this.client, spec);
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
        result.window_region_source = windowSpecified ? 'window_bbox' : 'caller_region';
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

  async inspectWindow(input = {}) {
    await this.ensureReady();
    return this.runExclusive(input, async () => {
      const result = await this.client.uiTree({
        ...input,
        inspectWindow: true,
        inline: input.inline !== false,
        inlineTarget: input.inlineTarget || 'preview'
      });
      if (result && typeof result === 'object') {
        const region = result?.window_region;
        if (region && typeof region === 'object') {
          result.window_region_source = result.window_region_source || 'window_bbox';
        }
      }
      return result;
    });
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

  async clickText(input = {}) {
    await this.ensureReady();
    return this.runExclusive(input, async () => {
      const query = String(input?.query || '').trim();
      if (!query) {
        throw new Error('desktop_click_text requires query');
      }

      let region = normalizeRegion(input?.region);
      if (!region) {
        region = await resolveWindowRegion(this.client, input);
      }

      const findResult = await this.client.findText({
        ...input,
        ...(region ? { region } : {})
      });
      const matches = Array.isArray(findResult?.matches) ? findResult.matches : [];
      // /find_text returns matches in OCR scan order, but the tool schema
      // promises occurrence:1 = "best match". Sort by confidence DESC so the
      // ranked-by-confidence contract holds; fall back to scan order for ties.
      const ranked = matches
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => {
          const ca = Number(a.entry?.confidence) || 0;
          const cb = Number(b.entry?.confidence) || 0;
          if (cb !== ca) return cb - ca;
          return a.index - b.index;
        })
        .map((item) => item.entry);
      const occurrence = Math.max(1, Number(input?.occurrence) || 1);
      const target = ranked[occurrence - 1];
      if (!target?.center || !Array.isArray(target.center) || target.center.length !== 2) {
        const error = new Error(`desktop_click_text found no clickable OCR match for ${query}`);
        error.code = 'TEXT_NOT_FOUND';
        throw error;
      }

      const clickResult = await this.client.clickAt({
        x: Number(target.center[0]) || 0,
        y: Number(target.center[1]) || 0,
        space: 'screen',
        button: input?.button || 'left',
        clicks: Number(input?.clicks) || 1,
        verifyHover: input?.verifyHover === true,
        leaseId: input?.leaseId,
        sessionId: input?.sessionId
      });

      let verification = null;
      if (input?.waitForChange !== false) {
        verification = await this.client.waitChange({
          windowHwnd: input?.windowHwnd,
          windowTitle: input?.windowTitle,
          windowClass: input?.windowClass,
          windowMatch: input?.windowMatch,
          ...(region ? { region } : {}),
          timeoutMs: input?.timeoutMs,
          pollMs: input?.pollMs,
          threshold: input?.threshold,
          leaseId: input?.leaseId,
          sessionId: input?.sessionId
        });
      }

      return {
        ok: true,
        action: 'click_text',
        query,
        match: input?.match || 'contains',
        occurrence,
        selectedMatch: target,
        matchCount: matches.length,
        click: clickResult,
        verification
      };
    });
  }

  async fillTextField(input = {}) {
    await this.ensureReady();
    return this.runExclusive(input, async () => {
      const text = String(input?.text ?? '');
      const controlType = String(input?.controlType || 'Edit').trim() || 'Edit';
      const spec = {
        ...input,
        controlType,
        text
      };

      // Verify the selector resolves to exactly one control BEFORE we mutate
      // anything. Python's /ui/act silently picks the first match when several
      // controls satisfy the selector, which in real apps (login dialogs with
      // a username Edit AND a password Edit, web forms with many inputs) is
      // exactly how text ends up in the wrong field. Reject ambiguous lookups
      // up front and hand the candidate list back so the caller can narrow
      // with automationId / name / nameMatch instead of guessing.
      const lookup = await this.client.uiFindAll(spec);
      const candidates = Array.isArray(lookup?.controls) ? lookup.controls : [];
      const candidateCount = Number(lookup?.count ?? candidates.length) || 0;
      if (candidateCount === 0) {
        const error = new Error(`desktop_fill_text_field could not find a ${controlType} control matching the selector`);
        error.code = 'CONTROL_NOT_FOUND';
        throw error;
      }
      if (candidateCount > 1) {
        const error = new Error(`desktop_fill_text_field selector is ambiguous (${candidateCount} ${controlType} controls matched). Narrow with automationId or name+nameMatch.`);
        error.code = 'AMBIGUOUS_CONTROL';
        error.candidates = candidates.slice(0, 10);
        throw error;
      }

      const setResult = await this.client.uiAct({
        ...spec,
        act: 'set_value'
      });

      // UIA ValuePattern.SetValue on Electron / Chrome / WPF often takes
      // 50-150 ms for the UIA tree to publish the new value, even though the
      // visible UI updates synchronously. A single get_text right after the
      // set therefore returns the OLD value and trips the readback check.
      // Retry a few times to absorb that async-replication window before
      // declaring failure — most apps settle on attempt 2.
      const requireExactReadback = input?.requireExactReadback !== false;
      const maxReadbackAttempts = 3;
      const readbackPollMs = 100;
      let readResult = null;
      let readText = '';
      let readbackMatches = false;
      let readbackAttempts = 0;
      for (let attempt = 1; attempt <= maxReadbackAttempts; attempt += 1) {
        if (attempt > 1) {
          await new Promise((resolve) => setTimeout(resolve, readbackPollMs));
        }
        readResult = await this.client.uiAct({
          ...spec,
          act: 'get_text'
        });
        readText = String(readResult?.text || '');
        readbackMatches = requireExactReadback
          ? readText === text
          : readText.includes(text);
        readbackAttempts = attempt;
        if (readbackMatches) break;
      }
      if (!readbackMatches) {
        const error = new Error(`desktop_fill_text_field read-back mismatch after ${readbackAttempts} attempts: expected ${JSON.stringify(text)} got ${JSON.stringify(readText)}`);
        error.code = 'READBACK_MISMATCH';
        throw error;
      }

      let submitResult = null;
      const submitKeys = String(input?.submitKeys || '').trim();
      if (submitKeys) {
        submitResult = await this.client.uiAct({
          ...spec,
          act: 'send_keys',
          keys: submitKeys
        });
      }

      return {
        ok: true,
        action: 'fill_text_field',
        controlType,
        expectedText: text,
        set: setResult,
        readback: {
          ...readResult,
          matches: readbackMatches,
          requireExactReadback,
          attempts: readbackAttempts
        },
        submit: submitResult
      };
    });
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
      // Cropping to the window before OCR is a big quality win: OCR over the
      // whole 2560x1600 desktop wastes ~3 seconds and surfaces every dashboard
      // / browser tab / taskbar tooltip as a "match", whereas the cropped path
      // typically returns in <500 ms with only window-local text.
      if (!region) {
        region = await resolveWindowRegion(this.client, spec);
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
      // Same trick as captureWindow: a wait_change that watches the whole desktop
      // will pick up clock ticks, taskbar animations, notification toasts, etc.
      // and falsely report "changed=true" even when the click did nothing to the
      // target window. Resolve the window bbox up front so we sample only there.
      if (!region) {
        region = await resolveWindowRegion(this.client, spec);
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
