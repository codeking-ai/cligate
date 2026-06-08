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

async function buildDesktopControlStatus() {
  const settings = desktopAgentService.getSettings();
  const enabled = settings?.enabled === true;
  const manager = desktopAgentService.manager?.getStatus?.() || {};
  const running = manager.running === true;

  let supported = false;
  let elevated = false;
  let machinePrepared = false;
  if (process.platform === 'win32') {
    supported = true;
    try {
      const cap = await desktopCaptureSetup.getStatus();
      supported = cap.supported !== false;
      elevated = cap.elevated === true;
      machinePrepared = cap.prepared === true;
    } catch {
      /* leave defaults */
    }
  }

  return {
    success: true,
    supported,
    enabled,
    running,
    elevated,
    machinePrepared,
    // Runtime works without admin; only the RDP-disconnect→console fallback needs it.
    needsAdminForFullSupport: enabled && process.platform === 'win32' && !machinePrepared && !elevated
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
      // Runs the full machine prep ONLY if CliGate is elevated; otherwise this is
      // a no-op that reports needsAdmin (we do not surface the raw command).
      try { await desktopCaptureSetup.enable(); } catch { /* best-effort */ }
    }
  } else {
    try { await desktopAgentService.stop(); } catch { /* ignore */ }
    desktopAgentService.updateSettings({ enabled: false });
    if (process.platform === 'win32') {
      try { await desktopCaptureSetup.disable(); } catch { /* best-effort */ }
    }
  }
  res.json(await buildDesktopControlStatus());
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
  handleSetDesktopControl
};
