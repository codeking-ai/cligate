# Screenshot Guide

This document defines how screenshots should be maintained for the repository and release-facing documentation.

## Why This Exists

CliGate changes quickly across:

- dashboard layout
- navigation structure
- routing flows
- runtime and channel features
- setup and operations surfaces

If screenshots are not maintained deliberately, `README.md`, `README_CN.md`, releases, and product docs drift away from the real product.

## Where Screenshots Are Used

- `README.md`
- `README_CN.md`
- release notes and release descriptions
- product walkthroughs and launch posts
- future docs pages or GitHub Pages content

## Minimum Screenshot Set

These are the recommended repository-facing screenshots for the current product shape:

1. `dashboard.png`
   Main system overview and quick actions.
2. `chat.png`
   Chat view with model testing or product assistant visible.
3. `accounts.png`
   Credential management for ChatGPT / Claude / Antigravity.
4. `settings.png`
   Routing, one-click config, or app assignment area.
5. `channel.png`
   Channel operations or conversation records.
6. `request_logs.png`
   Request logs, API explorer, or operational debugging view.

Optional supporting screenshots:

- `apikeys.png`
- `localmodel.png`
- `pricing.png`
- `resources.png`
- `tools_install.png`
- `usage_costs.png`

## Capture Rules

- Use the current production-like UI, not an outdated local prototype.
- Prefer one language per screenshot set. For repository screenshots, English is usually the better default.
- Use realistic but non-sensitive sample data.
- Do not expose tokens, cookies, account IDs, email addresses, or local absolute paths you do not want published.
- Keep the same visual theme across a set when possible.
- Avoid screenshots with modal clutter unless the modal is the feature being documented.

## Recommended Capture Format

- PNG for static UI
- GIF only for a short workflow where static images are insufficient
- Prefer widths that remain readable on GitHub without zooming
- Keep text legible at inline README sizes

## Naming Rules

- Use stable lowercase names with underscores only
- Prefer feature-oriented names over date-oriented names
- Replace an existing canonical screenshot when the feature evolves
- If you need archival variants, place them outside the primary `images/` names used by README

Examples:

- `dashboard.png`
- `chat.png`
- `channel.png`
- `request_logs.png`

## When Screenshots Must Be Updated

Update screenshots when any of these change materially:

- navigation structure
- visual layout of a README-linked page
- onboarding or setup flow
- routing or channel workflow surfaces
- branding, labels, or terminology shown in README

## Pull Request Rule

If a PR changes a README-visible page and the screenshot is no longer accurate, update the screenshot in the same PR or explicitly state why it is deferred.

## Recommended Capture Checklist

Before exporting a screenshot, verify:

1. no secrets are visible
2. no broken or placeholder UI is visible
3. the page title and feature state are understandable without extra explanation
4. the screenshot matches the wording now used in README and product docs
5. the screenshot reflects the current shipping UI rather than an old branch

## Current Repository Follow-up

The current repository should prioritize refreshing these first:

1. `dashboard.png`
2. `chat.png`
3. `settings.png`
4. `channel.png`
5. `request_logs.png`

Those five images define most first impressions on GitHub.
