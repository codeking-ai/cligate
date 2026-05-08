# Security Policy

## Supported Versions

Security fixes are best-effort for the latest development line and the latest published release.

## Reporting a Vulnerability

Please avoid posting sensitive details in a public issue.

Recommended order:

1. Use GitHub's private vulnerability reporting for this repository if it is enabled.
2. If private reporting is not available, open a GitHub Discussion or Issue with a minimal description and without secrets, tokens, cookies, or account identifiers.

## What to Include

- affected version or commit
- operating system
- reproduction steps
- impact summary
- whether credentials, tokens, or local files are exposed

## Sensitive Data Handling

Do not include any of the following in public reports:

- API keys
- OAuth refresh tokens
- session cookies
- full request logs containing secrets
- local config files with credentials

If you accidentally committed or exposed a secret, rotate it first and then report the incident.
