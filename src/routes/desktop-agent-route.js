import desktopAgentService from '../desktop-agent/service.js';
import desktopCaptureSetup from '../desktop-agent/capture-setup.js';

export async function handleGetDesktopAgentStatus(req, res) {
  const payload = await desktopAgentService.getStatus();
  res.json(payload);
}

export async function handleStartDesktopAgent(req, res) {
  const payload = await desktopAgentService.start();
  res.json(payload);
}

export async function handleStopDesktopAgent(req, res) {
  const payload = await desktopAgentService.stop();
  res.json(payload);
}

export function handleGetDesktopAgentSettings(req, res) {
  res.json({
    success: true,
    desktopAgent: desktopAgentService.getSettings()
  });
}

export function handleSetDesktopAgentSettings(req, res) {
  const body = req.body || {};
  const patch = {};

  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
    }
    patch.enabled = body.enabled;
  }

  if ('autoStart' in body) {
    if (typeof body.autoStart !== 'boolean') {
      return res.status(400).json({ success: false, error: 'autoStart must be a boolean' });
    }
    patch.autoStart = body.autoStart;
  }

  if ('baseUrl' in body) {
    if (typeof body.baseUrl !== 'string' || !body.baseUrl.trim()) {
      return res.status(400).json({ success: false, error: 'baseUrl must be a non-empty string' });
    }
    patch.baseUrl = body.baseUrl.trim();
  }

  if ('command' in body) {
    if (typeof body.command !== 'string') {
      return res.status(400).json({ success: false, error: 'command must be a string' });
    }
    patch.command = body.command.trim();
  }

  if ('args' in body) {
    if (!Array.isArray(body.args) || body.args.some((entry) => typeof entry !== 'string')) {
      return res.status(400).json({ success: false, error: 'args must be an array of strings' });
    }
    patch.args = body.args;
  }

  if ('idleTimeoutMs' in body) {
    if (!Number.isFinite(body.idleTimeoutMs)) {
      return res.status(400).json({ success: false, error: 'idleTimeoutMs must be a number' });
    }
    patch.idleTimeoutMs = body.idleTimeoutMs;
  }

  const desktopAgent = desktopAgentService.updateSettings(patch);
  res.json({
    success: true,
    desktopAgent
  });
}

// ---- Desktop-capture one-time setup (the "Desktop control" toggle) ----------

export async function handleGetDesktopCaptureSetupStatus(req, res) {
  res.json(await desktopCaptureSetup.getStatus());
}

export async function handleEnableDesktopCaptureSetup(req, res) {
  const autoLogin = req.body?.autoLogin === true;
  res.json(await desktopCaptureSetup.enable({ autoLogin }));
}

export async function handleDisableDesktopCaptureSetup(req, res) {
  res.json(await desktopCaptureSetup.disable());
}

// Remove the legacy auto-start tasks (CliGateDesktopAgent, CliGateServer) that
// brought the agent/CliGate up before the user opened CliGate.
export async function handleRemoveLegacyDesktopTasks(req, res) {
  res.json(await desktopCaptureSetup.removeLegacyTasks());
}

// ---- Single "Desktop control" switch -----------------------------------------
//
// ONE on/off control backs the whole feature. Turning it ON enables the
// CliGate-owned runtime agent (screenshot/click) AND — when CliGate runs as
// administrator — silently does the machine preparation in-process (removes
// legacy auto-start tasks, installs the race-safe RDP-disconnect→console task,
// keeps the desktop awake). The bundled setup script is invoked internally; the
// user never has to find or run a .ps1 by hand. Turning it OFF stops the agent
// and (when elevated) reverts the machine preparation. When CliGate is NOT
// elevated, the runtime agent still works; only the "survive RDP disconnect"
// extra needs admin, surfaced as a single short hint (no command, no file path).

// Dependencies are injectable purely so the per-platform branches (notably the
// macOS one, which never executes on a Windows CI box) stay unit-testable. The
// defaults preserve the exact production behaviour.
export async function buildDesktopControlStatus({
  platform = process.platform,
  service = desktopAgentService,
  captureSetup = desktopCaptureSetup
} = {}) {
  const settings = service.getSettings();
  const enabled = settings?.enabled === true;
  const manager = service.manager?.getStatus?.() || {};
  const running = manager.running === true;

  let supported = false;
  let elevated = false;
  let machinePrepared = false;
  let permissions = null;
  if (platform === 'win32') {
    supported = true;
    try {
      const cap = await captureSetup.getStatus();
      supported = cap.supported !== false;
      elevated = cap.elevated === true;
      machinePrepared = cap.prepared === true;
    } catch {
      /* leave defaults */
    }
  } else if (platform === 'darwin') {
    // macOS is supported via our native helper backend. There is no admin /
    // "machine preparation" step here — the only gate is TCC (Accessibility +
    // Screen Recording). When the helper is running it reports both through
    // /health; probe it best-effort (a plain client.health() that does NOT start
    // the agent) so the dashboard can guide the one-time permission grant.
    // elevated/machinePrepared stay false and never trigger the Windows admin hint.
    supported = true;
    try {
      const health = await service.client.health();
      permissions = {
        accessibility: health?.accessibility === true,
        screenRecording: health?.screen_recording === true
      };
    } catch {
      permissions = null; // helper not running yet → permission state unknown
    }
  }

  return {
    success: true,
    platform,
    supported,
    enabled,
    running,
    elevated,
    machinePrepared,
    // Only present on macOS once the helper has answered /health; omitted when
    // unknown or on Windows, so the existing Windows status shape is untouched.
    ...(permissions ? { permissions } : {}),
    // Runtime works without admin; only the RDP-disconnect→console fallback needs it.
    needsAdminForFullSupport: enabled && platform === 'win32' && !machinePrepared && !elevated
  };
}

export async function handleGetDesktopControl(req, res) {
  res.json(await buildDesktopControlStatus());
}

export async function handleSetDesktopControl(req, res) {
  const enable = req.body?.enabled === true;
  if (enable) {
    desktopAgentService.updateSettings({ enabled: true });
    try { await desktopAgentService.start(); } catch { /* surfaced via status.running */ }
    if (process.platform === 'win32') {
      // One-time machine preparation so screenshot/click survive an RDP
      // disconnect (race-safe reconnect-to-console + keep-awake). prepare() is
      // IDEMPOTENT: a no-op once the machine is already prepared (so re-toggling
      // never re-prompts for admin), runs in-process when CliGate is elevated,
      // and otherwise raises ONE Windows UAC consent. It never installs
      // auto-start tasks and never tears anything down.
      try { await desktopCaptureSetup.prepare(); } catch { /* best-effort; surfaced via status */ }
    }
  } else {
    // OFF stops ONLY the CliGate-owned runtime agent. The one-time machine
    // preparation (reconnect-to-console task, keep-awake) is intentionally LEFT
    // in place so the next enable needs no admin — that is the "set up once,
    // open/close freely" contract. Undoing the machine prep is a separate,
    // explicit action (POST /api/desktop-agent/capture-setup/disable).
    try { await desktopAgentService.stop(); } catch { /* ignore */ }
    desktopAgentService.updateSettings({ enabled: false });
  }
  res.json(await buildDesktopControlStatus());
}

// Explicit "authorize the one-time setup" action — backs the dashboard button
// shown when the runtime agent is on but the machine is not yet prepared and
// CliGate is not elevated. Triggers the single UAC consent (or runs in-process
// if already elevated). The dashboard then polls the status until prepared.
export async function handlePrepareDesktopControl(req, res) {
  if (process.platform !== 'win32') {
    return res.json({ success: false, supported: false });
  }
  let prepare = {};
  try {
    prepare = await desktopCaptureSetup.prepare();
  } catch (error) {
    prepare = { ok: false, error: String(error?.message || error) };
  }
  res.json({ ...(await buildDesktopControlStatus()), prepare });
}

export default {
  handleGetDesktopAgentStatus,
  handleStartDesktopAgent,
  handleStopDesktopAgent,
  handleGetDesktopAgentSettings,
  handleSetDesktopAgentSettings,
  handleGetDesktopCaptureSetupStatus,
  handleEnableDesktopCaptureSetup,
  handleDisableDesktopCaptureSetup,
  handleRemoveLegacyDesktopTasks,
  handleGetDesktopControl,
  handleSetDesktopControl,
  handlePrepareDesktopControl
};
