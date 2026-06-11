import path from 'node:path';
import { CONFIG_DIR } from '../account-manager.js';

// Canonical location for desktop-control runtime files (screenshots, OCR crops,
// inspect-window captures), shared by the Node side (the manager that spawns the
// agent, and the messaging handler that resolves a screenshot to send) and the
// Python agent itself.
//
// It lives under the CliGate data dir (~/.cligate, or CLIGATE_CONFIG_DIR) —
// NEVER the process CWD. The old default was `<cwd>/.tmp/desktop-control-agent`,
// which tied screenshots to wherever CliGate happened to be launched: in dev it
// polluted the source tree (e.g. <repo>/.tmp), and on a packaged or relocated
// install — or simply a different OS — that path is wrong or not writable.
// Resolving from CONFIG_DIR is identical on Windows / macOS / Linux, survives
// packaging, and respects CLIGATE_CONFIG_DIR (so tests and redirected installs
// stay isolated).
//
// DESKTOP_CONTROL_DIR overrides the location; the manager passes that exact value
// to the Python child via env, so both sides always resolve the SAME directory
// (the Node reader and the Python writer must agree, or a sent screenshot looks
// "missing").
export function desktopControlDir() {
  const override = String(process.env.DESKTOP_CONTROL_DIR || '').trim();
  return override || path.join(CONFIG_DIR, 'desktop-control');
}

export function desktopScreenshotsDir() {
  return path.join(desktopControlDir(), 'screenshots');
}

export default { desktopControlDir, desktopScreenshotsDir };
