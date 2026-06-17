import { pythonHttpBackend } from './python-http.js';
import { macosNativeBackend } from './macos-native.js';

// Pluggable desktop backend selection.
//
// The whole point of this layer is decoupling: `manager.js` no longer hard-codes
// "spawn python <script>". It asks resolveDesktopBackend() what to launch, and
// the answer depends on the platform. Everything above the spawn boundary
// (http-client, service, assistant tools, the dashboard toggle) is untouched
// because every backend exposes the SAME localhost HTTP contract.
//
// IMPORTANT — non-macOS behaviour must not change. Only `darwin` selects the new
// native helper; Windows, Linux, and anything else keep the existing Python HTTP
// agent, with the exact same command/args precedence as before.

function parsePort(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return parsed.port ? Number(parsed.port) : 8765;
  } catch {
    return 8765;
  }
}

export function selectDesktopBackend(platform = process.platform) {
  if (platform === 'darwin') {
    return macosNativeBackend;
  }
  return pythonHttpBackend;
}

/**
 * Resolve how to launch the local desktop agent for the current platform.
 *
 * Precedence is identical to the historical manager.js logic so a fresh install
 * (command:'' / args:[]) falls through to the per-platform defaults, while an
 * explicit settings.command / settings.args override still wins (the escape
 * hatch for e.g. pointing at python3 or a custom-built binary).
 *
 * @returns {{ id: string, command: string, args: string[], port: number }}
 */
export function resolveDesktopBackend({ platform = process.platform, settings = {}, token = '' } = {}) {
  const backend = selectDesktopBackend(platform);
  const port = parsePort(settings?.baseUrl);
  const defaults = backend.defaultLaunch({ port, token });
  const command = String(settings?.command || '').trim() || defaults.command;
  const args = Array.isArray(settings?.args) && settings.args.length > 0
    ? settings.args.map((entry) => String(entry))
    : defaults.args;
  return { id: backend.id, command, args, port };
}

export { pythonHttpBackend, macosNativeBackend, parsePort };

export default resolveDesktopBackend;
