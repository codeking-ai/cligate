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

export default {
  handleGetDesktopAgentStatus,
  handleStartDesktopAgent,
  handleStopDesktopAgent,
  handleGetDesktopAgentSettings,
  handleSetDesktopAgentSettings,
  handleGetDesktopCaptureSetupStatus,
  handleEnableDesktopCaptureSetup,
  handleDisableDesktopCaptureSetup
};
