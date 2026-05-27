import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { getServerSettings, setServerSettings, normalizeDesktopAgentConfig } from '../../src/server-settings.js';
import {
  handleGetDesktopAgentSettings,
  handleSetDesktopAgentSettings
} from '../../src/routes/desktop-agent-route.js';
import { AssistantDesktopClient } from '../../src/assistant-tools/desktop/client.js';
import { DesktopAgentService } from '../../src/desktop-agent/service.js';
import { DesktopAgentHttpClient } from '../../src/desktop-agent/http-client.js';

function mockRes() {
  return {
    _status: 200,
    _body: null,
    status(code) {
      this._status = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    }
  };
}

function mockReq(body = {}, params = {}, query = {}) {
  return { body, params, query };
}

test('normalizeDesktopAgentConfig applies defaults and bounds', () => {
  const normalized = normalizeDesktopAgentConfig({
    enabled: true,
    autoStart: true,
    baseUrl: ' http://127.0.0.1:9999 ',
    token: ' secret ',
    command: ' python ',
    args: ['a', 1, 'b'],
    idleTimeoutMs: 1000
  });

  assert.equal(normalized.enabled, true);
  assert.equal(normalized.autoStart, true);
  assert.equal(normalized.baseUrl, 'http://127.0.0.1:9999');
  assert.equal(normalized.token, 'secret');
  assert.equal(normalized.command, 'python');
  assert.deepEqual(normalized.args, ['a', 'b']);
  assert.equal(normalized.idleTimeoutMs, 60_000);
});

test('normalizeDesktopAgentConfig preserves default enabled flags when legacy config omits them', () => {
  const normalized = normalizeDesktopAgentConfig({
    baseUrl: 'http://127.0.0.1:9999'
  });

  assert.equal(normalized.enabled, true);
  assert.equal(normalized.autoStart, true);
  assert.equal(normalized.baseUrl, 'http://127.0.0.1:9999');
});

test('server settings persist normalized desktopAgent config', () => {
  setServerSettings({
    desktopAgent: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:9999',
      args: ['--port', '9999']
    }
  });

  const settings = getServerSettings();
  assert.equal(settings.desktopAgent.enabled, true);
  assert.equal(settings.desktopAgent.baseUrl, 'http://127.0.0.1:9999');
  assert.deepEqual(settings.desktopAgent.args, ['--port', '9999']);
});

test('desktop-agent route returns settings and accepts valid updates', () => {
  const getRes = mockRes();
  handleGetDesktopAgentSettings(mockReq(), getRes);
  assert.equal(getRes._status, 200);
  assert.equal(getRes._body.success, true);
  assert.equal(typeof getRes._body.desktopAgent, 'object');

  const setRes = mockRes();
  handleSetDesktopAgentSettings(mockReq({
    enabled: true,
    baseUrl: 'http://127.0.0.1:8877',
    autoStart: true,
    args: ['desktop-agent-server.py', '--port', '8877']
  }), setRes);

  assert.equal(setRes._status, 200);
  assert.equal(setRes._body.success, true);
  assert.equal(setRes._body.desktopAgent.enabled, true);
  assert.equal(setRes._body.desktopAgent.baseUrl, 'http://127.0.0.1:8877');
  assert.equal(setRes._body.desktopAgent.autoStart, true);
});

test('desktop-agent route rejects malformed payloads', () => {
  const res = mockRes();
  handleSetDesktopAgentSettings(mockReq({
    enabled: 'yes'
  }), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
});

test('AssistantDesktopClient forwards semantic desktop calls to the service', async () => {
  const calls = [];
  const client = new AssistantDesktopClient({
    service: {
      health: async () => {
        calls.push(['health']);
        return { ok: true };
      },
      windows: async (input) => {
        calls.push(['windows', input]);
        return { windows: [] };
      },
      focusWindow: async (input) => {
        calls.push(['focusWindow', input]);
        return { ok: true, action: 'focus' };
      },
      launchApp: async (input) => {
        calls.push(['launchApp', input]);
        return { ok: true, action: 'launch' };
      },
      captureWindow: async (input) => {
        calls.push(['captureWindow', input]);
        return { ok: true, action: 'screenshot' };
      },
      findControl: async (input) => {
        calls.push(['findControl', input]);
        return { ok: true, action: 'uia.find' };
      },
      findAllControls: async (input) => {
        calls.push(['findAllControls', input]);
        return { ok: true, action: 'uia.find_all' };
      },
      inspectWindow: async (input) => {
        calls.push(['inspectWindow', input]);
        return { ok: true, action: 'uia.inspect_window' };
      },
      actOnControl: async (input) => {
        calls.push(['actOnControl', input]);
        return { ok: true, action: input.act };
      },
      clickText: async (input) => {
        calls.push(['clickText', input]);
        return { ok: true, action: 'click_text' };
      },
      fillTextField: async (input) => {
        calls.push(['fillTextField', input]);
        return { ok: true, action: 'fill_text_field' };
      },
      waitForControl: async (input) => {
        calls.push(['waitForControl', input]);
        return { ok: true, action: 'uia.wait' };
      }
    }
  });

  await client.health();
  await client.listWindows({ title: 'Chrome' });
  await client.launchApp({ query: 'Chrome' });
  await client.focusWindow({ hwnd: 123 });
  await client.captureWindow({ windowHwnd: 123 });
  await client.findControl({ windowHwnd: 123, controlType: 'Edit' });
  await client.findAllControls({ windowHwnd: 123, controlType: 'Button' });
  await client.inspectWindow({ windowHwnd: 123, maxMarks: 20 });
  await client.clickText({ windowHwnd: 123, query: 'Publish' });
  await client.fillTextField({ windowHwnd: 123, automationId: 'title', text: 'Hello' });
  await client.actOnControl({ act: 'get_text', windowHwnd: 123, controlType: 'Text' });
  await client.waitForControl({ windowHwnd: 123, controlType: 'Button' });

  assert.deepEqual(calls, [
    ['health'],
    ['windows', { title: 'Chrome' }],
    ['launchApp', { query: 'Chrome' }],
    ['focusWindow', { hwnd: 123 }],
    ['captureWindow', { windowHwnd: 123 }],
    ['findControl', { windowHwnd: 123, controlType: 'Edit' }],
    ['findAllControls', { windowHwnd: 123, controlType: 'Button' }],
    ['inspectWindow', { windowHwnd: 123, maxMarks: 20 }],
    ['clickText', { windowHwnd: 123, query: 'Publish' }],
    ['fillTextField', { windowHwnd: 123, automationId: 'title', text: 'Hello' }],
    ['actOnControl', { act: 'get_text', windowHwnd: 123, controlType: 'Text' }],
    ['waitForControl', { windowHwnd: 123, controlType: 'Button' }]
  ]);
});

test('DesktopAgentService serializes exclusive actions by lease id', async () => {
  const events = [];
  let firstRelease;
  const firstGate = new Promise((resolve) => {
    firstRelease = resolve;
  });
  const service = new DesktopAgentService({
    manager: {
      getStatus: () => ({ running: true }),
      start: async () => ({ running: true })
    },
    client: {
      launch: async (input) => {
        events.push(`launch:${input.query}`);
        await firstGate;
        events.push(`launch_done:${input.query}`);
        return { ok: true };
      },
      focusWindow: async (input) => {
        events.push(`focus:${input.hwnd}`);
        return { ok: true };
      },
      uiFind: async () => ({ ok: true, window: { bbox: [1, 2, 3, 4] } }),
      screenshot: async () => ({ ok: true }),
      health: async () => ({ ok: true }),
      windows: async () => ({ ok: true }),
      uiAct: async () => ({ ok: true }),
      uiWait: async () => ({ ok: true })
    }
  });

  const first = service.launchApp({ query: 'AppA', leaseId: 'lease-1' });
  const second = service.focusWindow({ hwnd: 100, leaseId: 'lease-1' });
  firstRelease();
  await Promise.all([first, second]);

  assert.deepEqual(events, [
    'launch:AppA',
    'launch_done:AppA',
    'focus:100'
  ]);
});

test('DesktopAgentService clickText composes OCR lookup, click, and wait-change verification', async () => {
  const calls = [];
  const service = new DesktopAgentService({
    manager: {
      getStatus: () => ({ running: true }),
      start: async () => ({ running: true })
    },
    client: {
      health: async () => ({ ok: true }),
      uiFind: async () => ({ ok: true, window: { bbox: [10, 20, 300, 200] } }),
      findText: async (input) => {
        calls.push(['findText', input]);
        return {
          ok: true,
          matches: [
            { text: 'Publish', confidence: 0.93, bbox: [100, 120, 80, 24], center: [140, 132] }
          ]
        };
      },
      clickAt: async (input) => {
        calls.push(['clickAt', input]);
        return { ok: true, action: 'click', target: [input.x, input.y] };
      },
      waitChange: async (input) => {
        calls.push(['waitChange', input]);
        return { ok: true, action: 'wait_change', changed: true };
      }
    }
  });

  const result = await service.clickText({
    query: 'Publish',
    windowHwnd: 42,
    verifyHover: true,
    timeoutMs: 1200,
    sessionId: 'desktop-session-1',
    leaseId: 'desktop-lease-1'
  });

  assert.equal(result.action, 'click_text');
  assert.equal(result.selectedMatch.text, 'Publish');
  assert.equal(result.click.target[0], 140);
  assert.equal(result.click.target[1], 132);
  assert.equal(result.verification.changed, true);
  assert.deepEqual(calls, [
    ['findText', {
      query: 'Publish',
      windowHwnd: 42,
      verifyHover: true,
      timeoutMs: 1200,
      region: { x: 10, y: 20, w: 300, h: 200 },
      sessionId: 'desktop-session-1',
      leaseId: 'desktop-lease-1'
    }],
    ['clickAt', {
      x: 140,
      y: 132,
      space: 'screen',
      button: 'left',
      clicks: 1,
      verifyHover: true,
      leaseId: 'desktop-lease-1',
      sessionId: 'desktop-session-1'
    }],
    ['waitChange', {
      windowHwnd: 42,
      windowTitle: undefined,
      windowClass: undefined,
      windowMatch: undefined,
      region: { x: 10, y: 20, w: 300, h: 200 },
      timeoutMs: 1200,
      pollMs: undefined,
      threshold: undefined,
      leaseId: 'desktop-lease-1',
      sessionId: 'desktop-session-1'
    }]
  ]);
});

test('DesktopAgentService clickText ranks OCR matches by confidence DESC so occurrence:1 is the best match', async () => {
  const service = new DesktopAgentService({
    manager: {
      getStatus: () => ({ running: true }),
      start: async () => ({ running: true })
    },
    client: {
      health: async () => ({ ok: true }),
      uiFind: async () => ({ ok: true, window: { bbox: [0, 0, 800, 600] } }),
      findText: async () => ({
        ok: true,
        // Intentionally NOT sorted by confidence — /find_text emits OCR scan
        // order, which used to leak through and make occurrence:1 mean
        // "topmost scan hit" instead of "highest confidence".
        matches: [
          { text: 'Publish', confidence: 0.55, bbox: [50, 50, 60, 20], center: [80, 60] },
          { text: 'Publish', confidence: 0.92, bbox: [200, 300, 60, 20], center: [230, 310] },
          { text: 'Publish', confidence: 0.71, bbox: [400, 100, 60, 20], center: [430, 110] }
        ]
      }),
      clickAt: async (input) => ({ ok: true, action: 'click', target: [input.x, input.y] }),
      waitChange: async () => ({ ok: true, action: 'wait_change', changed: true })
    }
  });

  const first = await service.clickText({ query: 'Publish', windowHwnd: 99 });
  assert.equal(first.selectedMatch.confidence, 0.92);
  assert.deepEqual(first.click.target, [230, 310]);
  assert.equal(first.matchCount, 3);

  const second = await service.clickText({ query: 'Publish', windowHwnd: 99, occurrence: 2 });
  assert.equal(second.selectedMatch.confidence, 0.71);
  assert.deepEqual(second.click.target, [430, 110]);
});

test('DesktopAgentService fillTextField sets value, verifies read-back, and optionally submits', async () => {
  const calls = [];
  const service = new DesktopAgentService({
    manager: {
      getStatus: () => ({ running: true }),
      start: async () => ({ running: true })
    },
    client: {
      health: async () => ({ ok: true }),
      uiFindAll: async (input) => {
        calls.push(['uiFindAll', input]);
        return {
          ok: true,
          count: 1,
          controls: [{ automation_id: input.automationId, control_type: `${input.controlType}Control` }]
        };
      },
      uiAct: async (input) => {
        calls.push(['uiAct', input]);
        if (input.act === 'set_value') {
          return { ok: true, action: 'uia.set_value', control: { automation_id: input.automationId } };
        }
        if (input.act === 'get_text') {
          return { ok: true, action: 'uia.get_text', text: 'Hello Title', control: { automation_id: input.automationId } };
        }
        if (input.act === 'send_keys') {
          return { ok: true, action: 'uia.send_keys', keys: input.keys };
        }
        return { ok: true };
      }
    }
  });

  const result = await service.fillTextField({
    windowHwnd: 77,
    automationId: 'title',
    text: 'Hello Title',
    submitKeys: '{Enter}',
    sessionId: 'desktop-session-fill-1',
    leaseId: 'desktop-lease-fill-1'
  });

  assert.equal(result.action, 'fill_text_field');
  assert.equal(result.expectedText, 'Hello Title');
  assert.equal(result.readback.matches, true);
  assert.equal(result.readback.attempts, 1);
  assert.equal(result.submit.keys, '{Enter}');
  assert.deepEqual(calls, [
    ['uiFindAll', {
      windowHwnd: 77,
      automationId: 'title',
      text: 'Hello Title',
      submitKeys: '{Enter}',
      sessionId: 'desktop-session-fill-1',
      leaseId: 'desktop-lease-fill-1',
      controlType: 'Edit'
    }],
    ['uiAct', {
      windowHwnd: 77,
      automationId: 'title',
      text: 'Hello Title',
      submitKeys: '{Enter}',
      sessionId: 'desktop-session-fill-1',
      leaseId: 'desktop-lease-fill-1',
      controlType: 'Edit',
      act: 'set_value'
    }],
    ['uiAct', {
      windowHwnd: 77,
      automationId: 'title',
      text: 'Hello Title',
      submitKeys: '{Enter}',
      sessionId: 'desktop-session-fill-1',
      leaseId: 'desktop-lease-fill-1',
      controlType: 'Edit',
      act: 'get_text'
    }],
    ['uiAct', {
      windowHwnd: 77,
      automationId: 'title',
      text: 'Hello Title',
      submitKeys: '{Enter}',
      sessionId: 'desktop-session-fill-1',
      leaseId: 'desktop-lease-fill-1',
      controlType: 'Edit',
      act: 'send_keys',
      keys: '{Enter}'
    }]
  ]);
});

test('DesktopAgentService fillTextField rejects ambiguous selectors and exposes candidates', async () => {
  const service = new DesktopAgentService({
    manager: {
      getStatus: () => ({ running: true }),
      start: async () => ({ running: true })
    },
    client: {
      health: async () => ({ ok: true }),
      uiFindAll: async () => ({
        ok: true,
        count: 2,
        controls: [
          { control_type: 'EditControl', automation_id: 'username', name: 'Username' },
          { control_type: 'EditControl', automation_id: 'password', name: 'Password' }
        ]
      }),
      uiAct: async () => {
        throw new Error('uiAct must NOT be called when selector is ambiguous');
      }
    }
  });

  await assert.rejects(
    () => service.fillTextField({ windowHwnd: 7, text: 'admin' }),
    (err) => {
      assert.equal(err.code, 'AMBIGUOUS_CONTROL');
      assert.equal(err.candidates.length, 2);
      assert.equal(err.candidates[0].automation_id, 'username');
      return true;
    }
  );
});

test('DesktopAgentService fillTextField throws CONTROL_NOT_FOUND when selector matches nothing', async () => {
  const service = new DesktopAgentService({
    manager: {
      getStatus: () => ({ running: true }),
      start: async () => ({ running: true })
    },
    client: {
      health: async () => ({ ok: true }),
      uiFindAll: async () => ({ ok: true, count: 0, controls: [] }),
      uiAct: async () => {
        throw new Error('uiAct must NOT be called when no candidates exist');
      }
    }
  });

  await assert.rejects(
    () => service.fillTextField({ windowHwnd: 7, text: 'admin', automationId: 'missing' }),
    (err) => err.code === 'CONTROL_NOT_FOUND'
  );
});

test('DesktopAgentService fillTextField retries readback to absorb async UIA propagation', async () => {
  let getTextCallIndex = 0;
  const service = new DesktopAgentService({
    manager: {
      getStatus: () => ({ running: true }),
      start: async () => ({ running: true })
    },
    client: {
      health: async () => ({ ok: true }),
      uiFindAll: async () => ({
        ok: true,
        count: 1,
        controls: [{ automation_id: 'title', control_type: 'EditControl' }]
      }),
      uiAct: async (input) => {
        if (input.act === 'set_value') return { ok: true };
        if (input.act === 'get_text') {
          getTextCallIndex += 1;
          // Simulate Electron / Chrome: UIA tree publishes new value only on
          // the second poll, ~100 ms after SetValue returned.
          return getTextCallIndex === 1
            ? { ok: true, text: '' }
            : { ok: true, text: 'Hello World' };
        }
        return { ok: true };
      }
    }
  });

  const result = await service.fillTextField({
    windowHwnd: 1,
    automationId: 'title',
    text: 'Hello World'
  });
  assert.equal(result.readback.matches, true);
  assert.equal(result.readback.attempts, 2);
  assert.equal(getTextCallIndex, 2);
});

test('DesktopAgentHttpClient normalizes window spec and transport metadata', async () => {
  const calls = [];
  const client = new DesktopAgentHttpClient({
    getSettings: () => ({ baseUrl: 'http://127.0.0.1:8765', token: 'abc' }),
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return {
        ok: true,
        async json() {
          return { ok: true };
        }
      };
    }
  });

  await client.uiFind({
    windowHwnd: 100,
    windowTitle: 'Chrome',
    controlType: 'Edit',
    automationId: 'address',
    timeoutMs: 5000,
    leaseId: 'lease-a',
    sessionId: 'session-a',
    actionId: 'action-a'
  });

  const [, init] = calls[0];
  const body = JSON.parse(init.body);
  assert.equal(body.window_hwnd, 100);
  assert.equal(body.window_title, 'Chrome');
  assert.equal(body.control_type, 'Edit');
  assert.equal(body.automation_id, 'address');
  assert.equal(body.timeout_ms, 5000);
  assert.equal(body.lease_id, 'lease-a');
  assert.equal(body.session_id, 'session-a');
  assert.equal(body.action_id, 'action-a');
});

test('DesktopAgentHttpClient sends inspect-window specific fields to /ui/tree', async () => {
  const calls = [];
  const client = new DesktopAgentHttpClient({
    getSettings: () => ({ baseUrl: 'http://127.0.0.1:8765', token: 'abc' }),
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return {
        ok: true,
        async json() {
          return { ok: true };
        }
      };
    }
  });

  await client.uiTree({
    windowHwnd: 321,
    inspectWindow: true,
    maxMarks: 25,
    maxDepth: 12,
    previewWidth: 1440,
    leaseId: 'lease-inspect',
    sessionId: 'session-inspect'
  });

  const [url, init] = calls[0];
  const body = JSON.parse(init.body);
  assert.match(url, /\/ui\/tree$/);
  assert.equal(body.window_hwnd, 321);
  assert.equal(body.inspect_window, true);
  assert.equal(body.max_marks, 25);
  assert.equal(body.max_depth, 12);
  assert.equal(body.preview_width, 1440);
  assert.equal(body.lease_id, 'lease-inspect');
  assert.equal(body.session_id, 'session-inspect');
});

test('DesktopAgentService status includes lease metadata', async () => {
  const service = new DesktopAgentService({
    manager: { getStatus: () => ({ running: true, pid: 1 }) },
    client: {
      health: async () => ({ ok: true })
    }
  });

  service.activeLeaseId = 'lease-z';
  const status = await service.getStatus();

  assert.equal(status.success, true);
  assert.equal(status.lease.activeLeaseId, 'lease-z');
  assert.equal(status.lease.busy, true);
});

test('DesktopAgentService ensureReady auto-starts and waits for health', async () => {
  let started = 0;
  let healthCalls = 0;
  const service = new DesktopAgentService({
    manager: {
      getStatus: () => ({ running: started > 0 }),
      start: async () => {
        started += 1;
        return { running: true };
      }
    },
    client: {
      health: async () => {
        healthCalls += 1;
        if (healthCalls < 2) {
          throw new Error('warming_up');
        }
        return { ok: true };
      }
    }
  });

  service.getSettings = () => ({
    enabled: true
  });

  const ready = await service.ensureReady();
  assert.equal(ready, true);
  assert.equal(started, 1);
  assert.equal(healthCalls, 2);
});
