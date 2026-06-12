# Changelog

All notable user-facing changes should be documented in this file.

This changelog is maintained from source. Published release artifacts and tags remain the source of truth for shipped binaries and npm packages.

## 1.2.10 - 2026-06-12

### Fixed

- Fixed channel screenshot delivery failing with "image artifact not found": the assistant could see the captured screenshot but not its artifact id, so it fabricated an invalid handle when forwarding the image to DingTalk/Feishu/Telegram. Tool results now keep the structured fields (including `imageArtifactId`) visible to the model alongside the image.
- Sending an image by artifact handle is now self-healing: wrapped handles (`artifact:<tool>:<id>`) resolve via the embedded id, and a fabricated desktop-capture handle falls back to the newest screenshot instead of failing the send.
- Fixed the scheduled-task create/edit dialog overflowing on small screens with no way to scroll, which made the Save button unreachable. Dialogs now cap to the window height with a fixed header, a scrollable body, and an always-visible action bar.
- Restored missing size utility styles used across the dashboard (account quota details, skills lists, API explorer output, assistant workbench), so capped lists scroll inside their panel again instead of stretching the page.

## 1.2.9 - 2026-06-11

### Fixed

- Desktop control now survives a Remote Desktop disconnect reliably: a disconnected session is bounced back to the local console (physical or HDMI dummy display) instead of leaving the desktop locked, so the assistant no longer reports the desktop as unavailable after you disconnect.
- Desktop control setup is a one-time, click-to-authorize step. After authorizing once, turning desktop control off and on again no longer needs administrator rights, and turning it off no longer removes the machine preparation.
- Screenshots are now stored under the CliGate data directory (`~/.cligate/desktop-control/screenshots`) instead of a temporary folder tied to the launch location, so capture works consistently on packaged installs and across operating systems.
- Fixed "image not found / sent the latest screenshot instead" when forwarding a screenshot on a channel: captures now expose a stable image handle that the assistant can send directly.

## 1.2.8 - 2026-06-11

### Added

- Added WeChat channel provider support and channel UI improvements.
- Expanded Feishu and Telegram channel delivery coverage.
- Improved desktop-agent setup, reconnect, capture, and packaged runtime handling.

### Fixed

- Fixed chat history/debugging flows and assistant reply language handling.
- Improved tools/logs UI behavior and tool installer status handling.

## 1.2.4 - 2026-06-05

### Fixed

- Fixed the desktop app startup failure caused by the missing runtime `js-yaml` dependency in packaged builds.

## 1.2.3 - 2026-06-05

### Documentation

- Reorganized repository-facing documentation around a dedicated documentation hub.
- Split the GitHub landing page from the full product manual.
- Added contribution, security, changelog, and PR review guidance files.
- Added a lightweight local manual page at `/manual/`.
- Added a screenshot maintenance guide for repository-facing visuals.
- Added support and release documentation for repository operations.
- Hardened the npm release workflow and package publish configuration.
- Restored community contact entry points, including Discord and WeChat guidance.
