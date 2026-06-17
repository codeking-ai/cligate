#!/usr/bin/env bash
# Build the macOS desktop-agent helper, optionally self-sign it (for stable TCC
# permissions), and copy it to the location CliGate's macos-native backend
# resolves. Run on macOS only.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> swift build -c release"
swift build -c release

BIN=".build/release/cligate-desktop-agent"
if [[ ! -f "$BIN" ]]; then
  echo "build did not produce $BIN" >&2
  exit 1
fi

# Optional: sign with a (free self-signed or paid Developer ID) identity so the
# Accessibility / Screen Recording grant persists across rebuilds.
if [[ -n "${CLIGATE_CODESIGN_IDENTITY:-}" ]]; then
  echo "==> codesign with '$CLIGATE_CODESIGN_IDENTITY'"
  codesign --force --options runtime --sign "$CLIGATE_CODESIGN_IDENTITY" "$BIN"
else
  echo "==> (no CLIGATE_CODESIGN_IDENTITY set; skipping codesign — fine for local dev)"
fi

DEST="../../src/desktop-agent/runtime-macos/cligate-desktop-agent"
mkdir -p "$(dirname "$DEST")"
cp "$BIN" "$DEST"
echo "==> copied -> $DEST"
