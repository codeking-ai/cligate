import { getDesktopAgentSettings } from './settings.js';

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

  async request(path, { method = 'GET', body } = {}) {
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('fetch is not available');
    }
    const response = await this.fetchImpl(`${this.baseUrl()}${path}`, {
      method,
      headers: this.buildHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
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
    return this.request('/health');
  }

  windows({ title = '', match = 'contains' } = {}) {
    if (String(title || '').trim()) {
      return this.request('/windows', {
        method: 'POST',
        body: { title, match, ...withTransportMeta({ title, match }) }
      });
    }
    return this.request('/windows');
  }

  focusWindow({ hwnd = 0, title = '', match = 'contains' } = {}) {
    if (Number.isFinite(hwnd) && Number(hwnd) > 0) {
      return this.request('/focus', {
        method: 'POST',
        body: { hwnd: Number(hwnd), ...withTransportMeta({ hwnd }) }
      });
    }
    return this.request('/focus', {
      method: 'POST',
      body: { title, match, ...withTransportMeta({ title, match }) }
    });
  }

  uiFind(spec = {}) {
    return this.request('/ui/find', {
      method: 'POST',
      body: normalizeWindowSpec(spec)
    });
  }

  uiAct(spec = {}) {
    return this.request('/ui/act', {
      method: 'POST',
      body: normalizeWindowSpec(spec)
    });
  }

  uiWait(spec = {}) {
    return this.request('/ui/wait', {
      method: 'POST',
      body: normalizeWindowSpec(spec)
    });
  }

  uiFindAll(spec = {}) {
    return this.request('/ui/find_all', {
      method: 'POST',
      body: normalizeWindowSpec(spec)
    });
  }

  launch(input = {}) {
    return this.request('/launch', {
      method: 'POST',
      body: {
        ...input,
        ...withTransportMeta(input)
      }
    });
  }

  screenshot(input = {}) {
    return this.request('/screenshot', {
      method: 'POST',
      body: {
        ...input,
        ...withTransportMeta(input)
      }
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
      }
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
      }
    });
  }

  typeText(input = {}) {
    return this.request('/type', {
      method: 'POST',
      body: {
        text: String(input?.text ?? ''),
        ...(input?.preserveClipboard === false ? { preserve_clipboard: false } : {}),
        ...withTransportMeta(input)
      }
    });
  }
}

export default DesktopAgentHttpClient;
