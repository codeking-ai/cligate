# CLI Smoke Scenarios

CLI smoke tests are phase 2 of the automated testing framework.

These scenarios run real CLI binaries and then cross-check:

- exit code
- stdout/stderr
- request logs
- routing decisions

Scenario files live under subdirectories here and are executed by:

```bash
npm run test:e2e:cli:list
npm run test:e2e:cli
```

The runner is intentionally independent from normal application code and reuses the same
report output format as protocol scenarios.

Current status:

- `codex` text smoke is enabled and validated against the isolated proxy instance
- `codex` image smoke is enabled and uses a repo-local generated PNG fixture
- `codex` workspace smoke validates a task-style prompt against the current repo
- `claude-code` text smoke is enabled and runs through an isolated `settings.json` path, not the user's real Claude Code config
- `claude-code` haiku smoke validates the `claude-haiku-4 -> gpt-5.4-mini` mapped path via the real CLI

Use the isolated runner when the normal proxy instance is already serving real traffic:

```bash
npm run test:e2e:cli:isolated
```

To run protocol and CLI isolated suites together:

```bash
npm run test:e2e:isolated
```
