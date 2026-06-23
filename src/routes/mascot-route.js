/**
 * Desktop-mascot API (/api/mascot/*).
 *
 * - config: enable/character/position, persisted in server-settings.mascot.
 * - state:  current mascot mood + a manual setter (for demo / incremental wiring).
 * - events: SSE stream the mascot window subscribes to for live state changes.
 *
 * Independent of assistant internals — producers just call mascotStateBus.setState().
 */

import { getServerSettings, setServerSettings } from '../server-settings.js';
import mascotStateBus, { MASCOT_STATES } from '../mascot/state-bus.js';

const MASCOT_DEFAULTS = Object.freeze({
  enabled: true,
  character: 'placeholder',
  clickAction: 'open-chat',
  position: null
});

export function readMascotConfig() {
  const stored = getServerSettings().mascot || {};
  return { ...MASCOT_DEFAULTS, ...stored };
}

export function handleGetMascotConfig(req, res) {
  res.json({ success: true, config: readMascotConfig() });
}

export function handleUpdateMascotConfig(req, res) {
  const body = req.body || {};
  const next = { ...readMascotConfig() };
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (typeof body.character === 'string' && body.character.trim()) next.character = body.character.trim();
  if (typeof body.clickAction === 'string' && body.clickAction.trim()) next.clickAction = body.clickAction.trim();
  if (body.position === null) {
    next.position = null;
  } else if (body.position && typeof body.position === 'object') {
    const x = Number(body.position.x);
    const y = Number(body.position.y);
    if (Number.isFinite(x) && Number.isFinite(y)) next.position = { x: Math.round(x), y: Math.round(y) };
  }
  setServerSettings({ mascot: next });
  res.json({ success: true, config: readMascotConfig() });
}

export function handleGetMascotState(req, res) {
  res.json({ success: true, ...mascotStateBus.getState() });
}

export function handleSetMascotState(req, res) {
  const { state, text } = req.body || {};
  if (!MASCOT_STATES.includes(String(state))) {
    return res.status(400).json({ success: false, error: `state must be one of: ${MASCOT_STATES.join(', ')}` });
  }
  const next = mascotStateBus.setState(state, { text });
  res.json({ success: true, ...next });
}

export function handleMascotEvents(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (snapshot) => {
    try {
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    } catch {
      // client gone; cleanup happens on 'close'
    }
  };

  send(mascotStateBus.getState()); // prime the stream with the current state
  const unsubscribe = mascotStateBus.subscribe(send);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 25_000);
  heartbeat.unref?.(); // never keep the process alive on the heartbeat alone

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

export default {
  readMascotConfig,
  handleGetMascotConfig,
  handleUpdateMascotConfig,
  handleGetMascotState,
  handleSetMascotState,
  handleMascotEvents
};
