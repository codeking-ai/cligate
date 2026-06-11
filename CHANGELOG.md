# Changelog

All notable user-facing changes should be documented in this file.

This changelog is maintained from source. Published release artifacts and tags remain the source of truth for shipped binaries and npm packages.

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
