# cligate-desktop-agent (macOS native helper)

Our **own** native macOS desktop-control helper. It is the macOS counterpart of
the Windows Python agent (`src/desktop-agent/runtime/desktop-agent-server-impl.py`)
and speaks the **exact same localhost HTTP contract**, so everything above
`src/desktop-agent/http-client.js` in CliGate is platform-agnostic and unchanged.

We do **not** depend on any third-party computer-use package. Techniques are
informed by public references (Apple's Accessibility / CoreGraphics / Vision /
ScreenCaptureKit docs, and how projects like `cua` structure their macOS
backend), but all code here is ours and ships as our own signed binary.

## Why a native binary (not Python+PyObjC)

- **Zero runtime deps / "install → just works"**: one small executable, no
  bundled CPython or `pip install pyobjc`.
- **macOS-correct**: native `AXUIElement`, `CGEvent`, `ScreenCaptureKit`/
  `CGWindowList`, and `Vision` OCR — including background event paths that are
  awkward to reach from Python.
- **Stable TCC permissions**: Accessibility / Screen Recording grants attach to a
  binary with a *stable* code signature and survive app updates. A free,
  reused self-signed certificate is enough for this (see "Signing").
- **Ephemeral**: the helper runs only as a child of the CliGate process. There is
  **no launchd / daemon** — quitting CliGate ends desktop control, by design.

## Architecture (mirrors the Windows agent's HTTP contract)

```
CliGate (Node)  --spawn-->  cligate-desktop-agent  --AX/CGEvent/SCK/Vision-->  macOS
        \__ http-client.js --HTTP 127.0.0.1:<port> (Bearer token) --> HTTPServer.swift
```

Endpoints implemented to match the Windows contract (same JSON field names):

| Endpoint | Maps to (macOS) | Status |
|---|---|---|
| `GET /health` | screen size, cursor, frontmost app, TCC permission flags | ✅ core |
| `GET /active` `GET /windows` `GET /cursor_info` | `CGWindowList` / `NSWorkspace` | ✅ core |
| `POST /windows` `POST /focus` | enumerate / `NSRunningApplication.activate` + `AXRaise` | ✅ core |
| `POST /launch` | `NSWorkspace.openApplication` / `open -a` | ✅ core |
| `POST /screenshot` | `CGWindowListCreateImage` (window/region) → PNG | ✅ core |
| `POST /ui/find` `POST /ui/find_all` | `AXUIElement` tree match | ✅ core |
| `POST /ui/act` (`click`/`set_value`/`get_value`/`get_text`/`focus`/`send_keys`) | `AXPress` / set `kAXValueAttribute` / focus | ✅ core |
| `POST /ui/tree` | AX tree dump (+ inspect marks) | 🟡 tree ok, inspect-mark overlay TODO |
| `POST /move` `POST /click` `POST /type` `POST /press` `POST /hotkey` `POST /scroll` | `CGEvent` | ✅ core |
| `POST /find_text` | `Vision` `VNRecognizeTextRequest` | ✅ core |
| `POST /wait` `POST /wait_change` | sleep / pixel-diff sampling | 🟡 wait ok, wait_change TODO |
| `POST /ui/wait` | poll AX until condition | 🟡 TODO |

🟡 = compiles/responds but needs on-device iteration. Background (focus-free)
event posting via SkyLight is a **later phase**; the current input path uses
`CGEvent` (may briefly require the target app to be frontmost).

> NOTE: This source was authored on Windows and has **not yet been compiled on a
> Mac**. Treat the first `swift build` on macOS as the real bring-up: expect to
> fix availability annotations, optional unwrapping, and a few API signatures.
> The structure, contract, and per-domain logic are the deliverable.

## Build

```bash
cd native/macos-desktop-agent
swift build -c release
# or: ./build.sh   (builds, self-signs, and copies into src/desktop-agent/runtime-macos/)
```

Requirements: macOS 12+, Xcode command-line tools (`swift`), Swift 5.7+.

## Signing (free, no paid Apple account needed for the feature to work)

TCC permission persistence needs a *stable* signature, not a paid Developer ID:

1. Keychain Access → Certificate Assistant → Create a Certificate → type
   **Code Signing**, self-signed. Create it **once** and reuse it.
2. `codesign --force --options runtime --sign "<YourCertName>" cligate-desktop-agent`
   (or let `build.sh` do it via `CLIGATE_CODESIGN_IDENTITY`).

Notarization (removes the first-launch Gatekeeper prompt) additionally needs a
$99/yr Apple Developer ID — optional, and it changes nothing in this code.

## Run / smoke test

```bash
./.build/release/cligate-desktop-agent --port 8765 --token testtoken &
curl -s -H "Authorization: Bearer testtoken" http://127.0.0.1:8765/health | python3 -m json.tool
```

First run will prompt for Accessibility and Screen Recording in System Settings.
