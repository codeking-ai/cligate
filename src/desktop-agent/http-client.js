import { getDesktopAgentSettings } from './settings.js';

// Every desktop request is capped with an AbortController. Without a deadline a
// hung server-side action (classically a Windows UAC / "secure desktop" prompt
// or an elevated installer window a medium-integrity agent cannot drive) left
// the fetch waiting on undici's ~5-minute default header timeout, then surfaced
// as a misleading "fetch failed / AgentUnreachable" minutes later — even though
// the agent process was alive the whole time (its lock-free /health kept
// answering in milliseconds). A bounded, per-endpoint timeout turns that into a
// fast, correctly-labelled AGENT_TIMEOUT.
const DEFAULT_TIMEOUT_MS = 30000;
const QUICK_TIMEOUT_MS = 8000;

// UIA/wait endpoints carry a server-side action budget (timeout_ms, default
// 4s). The client deadline must sit safely ABOVE that budget plus headroom for
// the COM round-trip, screenshot encoding, and disk IO, so it never fires
// before a legitimately slow-but-progressing action.
function uiaTimeout(spec = {}, headroomMs = 15000) {
  const serverBudget = Number(spec?.timeoutMs ?? spec?.timeout_ms) || 4000;
  return serverBudget + headroomMs;
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  return text || 'http://127.0.0.1:8765';
}

function withTransportMeta(input = {}) {
  const leaseId = String(input?.leaseId || input?.lease_id || '').trim();
  const sessionId = String(input?.sessionId || input?.session_id || '').trim();
  const actionId = String(input?.actionId || input?.action_id || '').trim();
  return {
    ...(leaseId ? { lease_id: leaseId } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(actionId ? { action_id: actionId } : {})
  };
}

function normalizeWindowSpec(input = {}) {
  return {
    ...input,
    ...(Number.isFinite(input.windowHwnd) ? { window_hwnd: Number(input.windowHwnd) } : {}),
    ...(typeof input.windowTitle === 'string' ? { window_title: input.windowTitle } : {}),
    ...(typeof input.windowClass === 'string' ? { window_class: input.windowClass } : {}),
    ...(typeof input.windowMatch === 'string' ? { window_match: input.windowMatch } : {}),
    ...(typeof input.controlType === 'string' ? { control_type: input.controlType } : {}),
    ...(typeof input.nameMatch === 'string' ? { name_match: input.nameMatch } : {}),
    ...(typeof input.automationId === 'string' ? { automation_id: input.automationId } : {}),
    ...(typeof input.className === 'string' ? { class_name: input.className } : {}),
    ...(Number.isFinite(input.searchDepth) ? { search_depth: Number(input.searchDepth) } : {}),
    ...(Number.isFinite(input.timeoutMs) ? { timeout_ms: Number(input.timeoutMs) } : {}),
    ...(Number.isFinite(input.maxItems) ? { max_items: Number(input.maxItems) } : {}),
    ...withTransportMeta(input)
  };
}

export class DesktopAgentHttpClient {
  constructor({
    getSettings = getDesktopAgentSettings,
    fetchImpl = globalThis.fetch
  } = {}) {
    this.getSettings = getSettings;
    this.fetchImpl = fetchImpl;
  }

  buildHeaders(extra = {}) {
    const settings = this.getSettings();
    const token = String(settings?.token || '').trim();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra
    };
  }

  baseUrl() {
    return normalizeBaseUrl(this.getSettings()?.baseUrl);
  }

  async request(path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('fetch is not available');
    }
    const deadlineMs = Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl()}${path}`, {
        method,
        headers: this.buildHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      // An aborted fetch means the agent did not respond in time. Surface this
      // as AGENT_TIMEOUT (NOT AgentUnreachable): the process is usually alive
      // but an action is stuck — most often a UAC/secure-desktop prompt. The
      // distinction drives a very different recovery path in handlers/desktop.js
      // (don't retry-spam; check session_locked; ask the user to handle the
      // prompt) versus "the server is down, restart it".
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        const timeoutError = new Error(
          `desktop_agent_timeout: no response from ${path} within ${deadlineMs}ms `
          + '(the desktop agent is likely alive but an action is stuck — e.g. a Windows UAC / '
          + 'secure-desktop prompt, an elevated window, or a locked screen a normal-privilege '
          + 'agent cannot drive)'
        );
        timeoutError.code = 'AGENT_TIMEOUT';
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok || payload?.ok === false) {
      const error = new Error(String(payload?.error || `desktop_agent_http_${response.status}`));
      // Python server reports the exception class name as `type` (e.g.
      // "ModuleNotFoundError", "RuntimeError"). Surface it as the error code so
      // handlers/desktop.js can branch on it for actionable recovery hints.
      error.code = String(payload?.code || payload?.type || `HTTP_${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  health() {
    return this.request('/health', { timeoutMs: QUICK_TIMEOUT_MS });
  }

  windows({ title = '', match = 'contains' } = {}) {
    if (String(title || '').trim()) {
      return this.request('/windows', {
        method: 'POST',
        body: { title, match, ...withTransportMeta({ title, match }) },
        timeoutMs: 12000
      });
    }
    return this.request('/windows', { timeoutMs: 12000 });
  }

  focusWindow({ hwnd = 0, title = '', match = 'contains' } = {}) {
    if (Number.isFinite(hwnd) && Number(hwnd) > 0) {
      return this.request('/focus', {
        method: 'POST',
        body: { hwnd: Number(hwnd), ...withTransportMeta({ hwnd }) },
        timeoutMs: 15000
      });
    }
    return this.request('/focus', {
      method: 'POST',
      body: { title, match, ...withTransportMeta({ title, match }) },
      timeoutMs: 15000
    });
  }

  uiFind(spec = {}) {
    return this.request('/ui/find', {
      method: 'POST',
      body: normalizeWindowSpec(spec),
      timeoutMs: uiaTimeout(spec)
    });
  }

  uiAct(spec = {}) {
    return this.request('/ui/act', {
      method: 'POST',
      body: normalizeWindowSpec(spec),
      timeoutMs: uiaTimeout(spec)
    });
  }

  uiWait(spec = {}) {
    return this.request('/ui/wait', {
      method: 'POST',
      body: normalizeWindowSpec(spec),
      timeoutMs: uiaTimeout(spec)
    });
  }

  uiFindAll(spec = {}) {
    return this.request('/ui/find_all', {
      method: 'POST',
      body: normalizeWindowSpec(spec),
      timeoutMs: uiaTimeout(spec)
    });
  }

  uiTree(spec = {}) {
    return this.request('/ui/tree', {
      // Tree walks the full control hierarchy and, in inspect mode, also takes
      // and annotates a screenshot — give it more headroom than a plain find.
      timeoutMs: uiaTimeout(spec, 30000),
      method: 'POST',
      body: {
        ...normalizeWindowSpec(spec),
        inspect_window: spec?.inspectWindow === true,
        ...(Number.isFinite(spec?.maxMarks) ? { max_marks: Number(spec.maxMarks) } : {}),
        ...(Number.isFinite(spec?.maxDepth) ? { max_depth: Number(spec.maxDepth) } : {}),
        ...(Number.isFinite(spec?.maxNodes) ? { max_nodes: Number(spec.maxNodes) } : {}),
        ...(Number.isFinite(spec?.previewWidth) ? { preview_width: Number(spec.previewWidth) } : {}),
        ...(spec?.inline === false ? { inline: false } : { inline: true }),
        ...(typeof spec?.inlineTarget === 'string' ? { inline_target: spec.inlineTarget } : {}),
      }
    });
  }

  launch(input = {}) {
    return this.request('/launch', {
      method: 'POST',
      body: {
        ...input,
        ...withTransportMeta(input)
      },
      timeoutMs: 20000
    });
  }

  screenshot(input = {}) {
    return this.request('/screenshot', {
      method: 'POST',
      body: {
        ...input,
        ...withTransportMeta(input)
      },
      timeoutMs: 25000
    });
  }

  // Low-level keyboard endpoints. Exposed as their own helpers so the model can
  // do "focus window → Ctrl+L → type URL → Enter" — the standard Windows way of
  // opening a URL — without needing to first locate a specific UIA Edit control.
  pressKey(input = {}) {
    return this.request('/press', {
      method: 'POST',
      body: {
        key: String(input?.key || '').trim(),
        ...withTransportMeta(input)
      },
      timeoutMs: 20000
    });
  }

  hotkey(input = {}) {
    const keys = Array.isArray(input?.keys)
      ? input.keys.map((k) => String(k || '').trim()).filter(Boolean)
      : String(input?.keys || '').split(/[\s,+]+/).map((k) => k.trim()).filter(Boolean);
    return this.request('/hotkey', {
      method: 'POST',
      body: {
        keys,
        ...withTransportMeta(input)
      },
      timeoutMs: 20000
    });
  }

  typeText(input = {}) {
    return this.request('/type', {
      method: 'POST',
      body: {
        text: String(input?.text ?? ''),
        ...(input?.preserveClipboard === false ? { preserve_clipboard: false } : {}),
        ...withTransportMeta(input)
      },
      timeoutMs: 20000
    });
  }

  // Raw mouse endpoints. Use when UIA cannot locate a control but the screen
  // capture lets the model identify the target by pixel coordinates. The
  // Python server's resolve_point() supports several coordinate spaces — see
  // the `space` field on each call.
  clickAt(input = {}) {
    return this.request('/click', {
      method: 'POST',
      body: {
        x: Number(input?.x) || 0,
        y: Number(input?.y) || 0,
        space: String(input?.space || 'screen'),
        button: String(input?.button || 'left'),
        clicks: Number(input?.clicks) || 1,
        ...(input?.region ? { region: input.region } : {}),
        ...(input?.previewWidth ? { preview_width: Number(input.previewWidth) } : {}),
        ...(input?.previewHeight ? { preview_height: Number(input.previewHeight) } : {}),
        ...(input?.verifyHover === true ? { verify_hover: true } : {}),
        ...withTransportMeta(input)
      },
      timeoutMs: 20000
    });
  }

  moveMouse(input = {}) {
    return this.request('/move', {
      method: 'POST',
      body: {
        x: Number(input?.x) || 0,
        y: Number(input?.y) || 0,
        space: String(input?.space || 'screen'),
        ...(input?.region ? { region: input.region } : {}),
        ...(input?.previewWidth ? { preview_width: Number(input.previewWidth) } : {}),
        ...(input?.previewHeight ? { preview_height: Number(input.previewHeight) } : {}),
        ...withTransportMeta(input)
      },
      timeoutMs: 20000
    });
  }

  scroll(input = {}) {
    return this.request('/scroll', {
      method: 'POST',
      body: {
        amount: Number(input?.amount) || 0,
        ...withTransportMeta(input)
      },
      timeoutMs: 15000
    });
  }

  waitChange(input = {}) {
    return this.request('/wait_change', {
      method: 'POST',
      body: {
        ...(input?.region ? { region: input.region } : {}),
        ...(Number.isFinite(input?.timeoutMs) ? { timeout_ms: Number(input.timeoutMs) } : {}),
        ...(Number.isFinite(input?.pollMs) ? { poll_ms: Number(input.pollMs) } : {}),
        ...(Number.isFinite(input?.threshold) ? { threshold: Number(input.threshold) } : {}),
        ...(Number.isFinite(input?.signatureSize) ? { signature_size: Number(input.signatureSize) } : {}),
        ...withTransportMeta(input)
      },
      // /wait_change blocks server-side for up to its own timeout_ms (default
      // 1500) while polling — wait at least that long plus headroom.
      timeoutMs: uiaTimeout({ timeoutMs: Number(input?.timeoutMs) || 1500 })
    });
  }

  cursorInfo() {
    return this.request('/cursor_info', { timeoutMs: QUICK_TIMEOUT_MS });
  }

  findText(input = {}) {
    return this.request('/find_text', {
      method: 'POST',
      body: {
        query: String(input?.query || ''),
        match: String(input?.match || 'contains'),
        ...(Number.isFinite(input?.minConfidence) ? { min_confidence: Number(input.minConfidence) } : {}),
        ...(Number.isFinite(input?.maxResults) ? { max_results: Number(input.maxResults) } : {}),
        ...(input?.region ? { region: input.region } : {}),
        ...withTransportMeta(input)
      },
      // OCR is the slowest endpoint: the first call lazily downloads the RapidOCR
      // ONNX models (~30 MB), and inference over a large region is seconds. Give
      // it a generous ceiling so a legitimate first run is never aborted.
      timeoutMs: 90000
    });
  }
}

export default DesktopAgentHttpClient;
