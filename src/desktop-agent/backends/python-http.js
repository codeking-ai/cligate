import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// Windows (and any non-macOS) desktop backend: the bundled Python HTTP agent.
//
// This module owns the runtime-script resolution that used to live in
// manager.js. It is the DEFAULT backend for every platform except macOS, so
// Windows/Linux behaviour is byte-for-byte identical to the pre-backends code:
// command defaults to `python`, args default to `[<script>, --port, <port>,
// --token, <token>]`.
const __dirname = dirname(fileURLToPath(import.meta.url));

// backends/ sits one level under desktop-agent/, so step back up to reach the
// runtime/ directory the script has always lived in.
const DEFAULT_SCRIPT = join(__dirname, '..', 'runtime', 'desktop-agent-server.py');

export function resolveRuntimeScript() {
  // Electron packs src/ into app.asar but unpacks the Python runtime (it must
  // stay an on-disk file the spawned interpreter can read). Prefer the unpacked
  // copy when we are running from inside an asar.
  const unpackedCandidate = DEFAULT_SCRIPT.includes('app.asar')
    ? DEFAULT_SCRIPT.replace('app.asar', 'app.asar.unpacked')
    : DEFAULT_SCRIPT;
  if (existsSync(unpackedCandidate)) {
    return unpackedCandidate;
  }
  return DEFAULT_SCRIPT;
}

export const pythonHttpBackend = {
  id: 'python-http',
  // Returns the launch defaults applied when the user has NOT overridden
  // settings.command / settings.args. Mirrors the historical manager.js logic.
  defaultLaunch({ port, token }) {
    return {
      command: 'python',
      args: [resolveRuntimeScript(), '--port', String(port), '--token', String(token)]
    };
  }
};

export { DEFAULT_SCRIPT };

export default pythonHttpBackend;
