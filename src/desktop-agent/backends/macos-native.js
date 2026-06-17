import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// macOS desktop backend: our OWN native helper binary (Swift), source in
// native/macos-desktop-agent/. It speaks the EXACT same localhost HTTP contract
// as the Windows Python agent (/health, /windows, /ui/find, /ui/act,
// /screenshot, /click, ...), so nothing above http-client.js changes when this
// backend is selected. The platform difference (UIA -> AX, SendInput -> CGEvent,
// mss -> ScreenCaptureKit, RapidOCR -> Vision) is absorbed entirely inside the
// helper.
//
// We deliberately ship our own signed binary instead of depending on any
// third-party package, and the helper runs ONLY as a child of the CliGate
// process — there is no launchd/daemon, so closing CliGate ends desktop control.
const __dirname = dirname(fileURLToPath(import.meta.url));

// The compiled binary is copied here by native/macos-desktop-agent/build.sh.
// Lives alongside the Python runtime so the Electron build can asarUnpack it the
// same way; runtime-macos/ keeps the platform artifacts separate from the source.
const DEFAULT_BINARY = join(__dirname, '..', 'runtime-macos', 'cligate-desktop-agent');

export function resolveMacAgentBinary() {
  const unpackedCandidate = DEFAULT_BINARY.includes('app.asar')
    ? DEFAULT_BINARY.replace('app.asar', 'app.asar.unpacked')
    : DEFAULT_BINARY;
  if (existsSync(unpackedCandidate)) {
    return unpackedCandidate;
  }
  return DEFAULT_BINARY;
}

export const macosNativeBackend = {
  id: 'macos-native',
  // The helper takes the same --port/--token flags as the Python script; it has
  // no script argument because it IS the executable.
  defaultLaunch({ port, token }) {
    return {
      command: resolveMacAgentBinary(),
      args: ['--port', String(port), '--token', String(token)]
    };
  }
};

export { DEFAULT_BINARY };

export default macosNativeBackend;
