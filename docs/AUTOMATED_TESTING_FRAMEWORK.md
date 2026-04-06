# Automated Testing Framework

## Goals

This project needs an automated testing system that validates the real proxy behavior without polluting the normal runtime path.

The framework must:

- verify routing, account rotation, model mapping, and protocol translation through real proxy endpoints
- keep test code isolated from normal application code
- make new features easy to cover by adding scenarios instead of rewriting infrastructure
- provide actionable failure output with scenario-level and assertion-level detail
- use real upstream services when available, with strict assertions for smoke-critical paths

## Non-Goals For Phase 1

Phase 1 intentionally does not include:

- a dashboard "Testing" tab
- a server-side `/api/test/*` orchestration layer
- a large built-in scenario catalog
- intrusive "test mode" branches in normal request handlers

Those can be added later if the first phase proves useful.

## Test Layers

### L1. Unit And Protocol-Conversion Tests

Location: `tests/unit/`

Purpose:

- translator logic
- route helpers
- account rotation
- model mapping
- schema normalization

These remain the fastest regression layer and should continue to grow with new pure logic.

### L2. Protocol Scenario Tests

Location: `tests/e2e/protocol/`

Purpose:

- hit the same proxy endpoints real CLIs use
- apply temporary settings changes
- send representative requests
- validate response shape, logs, and routing decisions

This is the main end-to-end regression layer.

### L3. CLI Smoke Tests

Location: `tests/e2e/cli/`

Purpose:

- run real `codex`, `claude`, or `gemini` commands against the proxy
- confirm that real clients still work after protocol tests pass

This is a small smoke layer, not the main coverage layer.

## Design Principles

### 1. Keep Test Code Separate

The test framework lives under `tests/e2e/` and reuses existing public endpoints:

- `/v1/messages`
- `/v1/responses`
- `/backend-api/codex/responses`
- `/v1beta/models/*`
- `/api/request-logs`
- `/api/runtime/routing-decisions`
- `/settings/*`

Only thin, read-only support hooks should ever be added to `src/`, and only if current APIs are insufficient.

### 2. Organize By Client Protocol, Not By Provider

Scenarios are grouped by the client protocol surface they validate:

- `claude-code`
- `codex`
- `gemini-cli`

This keeps the framework aligned with real compatibility guarantees.

### 3. Prefer Structured Evidence Over Console-Only Output

Every run should generate:

- terminal summary
- JSON report
- failure artifacts when a scenario fails

## Directory Layout

```text
tests/
  e2e/
    fixtures/
      images/
    lib/
      assertions.js
      http-client.js
      logs-driver.js
      scenario-loader.js
      scenario-runner.js
      settings-driver.js
      sse-parser.js
      report-writer.js
    protocol/
      scenarios/
        claude-code/
        codex/
        gemini-cli/
```

Phase 1 focuses on `tests/e2e/lib/` and `tests/e2e/protocol/scenarios/`.

Current scenario inventory:

- protocol:
  - `claude-code/text-basic`
  - `claude-code/stream-basic`
  - `claude-code/image-basic`
  - `claude-code/haiku-mapped`
  - `codex/responses-basic`
  - `codex/backend-basic`
- cli smoke:
  - `claude-code/text-basic`
  - `claude-code/haiku-basic`
  - `codex/text-basic`
  - `codex/image-basic`
  - `codex/workspace-basic`

## Scenario Format

Scenarios are declarative JSON files.

Example:

```json
{
  "id": "claude-code-text-basic",
  "name": "Claude Code Text Basic",
  "kind": "protocol",
  "client": "claude-code",
  "entry": "/v1/messages",
  "request": {
    "method": "POST",
    "path": "/v1/messages",
    "headers": {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-proxypool-client": "claude-code"
    },
    "body": {
      "model": "claude-sonnet-4-6",
      "stream": false,
      "max_tokens": 128,
      "messages": [
        { "role": "user", "content": "Reply with exactly OK_CLAUDE_TEST" }
      ]
    }
  },
  "setup": {
    "requests": [
      {
        "method": "POST",
        "path": "/settings/routing-priority",
        "body": { "routingPriority": "account-first" }
      },
      {
        "method": "POST",
        "path": "/settings/account-strategy",
        "body": { "accountStrategy": "sequential" }
      }
    ]
  },
  "assertions": [
    { "type": "status", "expected": 200 },
    { "type": "content-type", "contains": "application/json" },
    { "type": "body-json-exists", "path": "content" },
    { "type": "body-text-contains", "contains": "OK_CLAUDE_TEST" },
    {
      "type": "request-log",
      "expected": {
        "route": "/v1/messages",
        "success": true
      }
    }
  ]
}
```

## Phase 1 Assertion Set

Phase 1 supports a focused assertion set:

- `status`
- `content-type`
- `body-json-exists`
- `body-json-type`
- `body-text-contains`
- `sse-event-sequence`
- `duration-max`
- `request-log`
- `routing-decision`

Critical smoke scenarios should use strict expectations. Broad "200/401/429/503 all acceptable" assertions are not suitable as the main signal.

## Settings Isolation

Before a run starts, the runner snapshots supported mutable settings and restores them after the run:

- `accountStrategy`
- `routingPriority`
- `routingMode`
- `strictCodexCompatibility`
- `strictTranslatorCompatibility`
- `enableFreeModels`

Scenario-specific setup requests are then applied on top of the snapshot.

## Result Model

Each run produces a report written to `tests/reports/`.

Result structure:

- run id
- start/end timestamps
- selected scenarios
- pass/fail summary
- per-scenario status
- per-assertion details
- response summary
- request-log excerpt
- routing-decision excerpt

If a scenario fails, raw artifacts should be written under:

```text
tests/reports/artifacts/<runId>/<scenarioId>/
```

## Phase 1 Deliverables

1. `tests/e2e/lib/` protocol runner
2. report writer
3. first protocol scenarios:
   - `claude-code/text-basic`
   - `claude-code/stream-basic`
   - `claude-code/image-basic`
   - `claude-code/haiku-mapped`
   - `codex/responses-basic`
   - `codex/backend-basic`
4. package scripts:
   - `test:e2e:protocol`
   - `test:e2e:protocol:list`
   - `test:e2e:protocol:isolated`
   - `test:e2e:cli`
   - `test:e2e:cli:list`
   - `test:e2e:cli:isolated`

## CLI Smoke Plan

CLI smoke tests are phase 2. They will:

- spawn real CLI binaries
- point them to the proxy
- capture stdout/stderr and exit code
- cross-check request logs and routing decisions

Current smoke targets:

- Codex text basic
- Codex image basic
- Codex workspace basic
- Claude Code text basic
- Claude Code haiku mapped basic

The CLI runner is implemented in:

- `tests/e2e/lib/cli-runner.js`
- `tests/e2e/lib/run-isolated-cli.js`

CLI scenarios intentionally remain separate from protocol scenarios. The protocol layer
proves schema and translation compatibility, while the CLI layer only verifies a small set
of real end-to-end invocations against an isolated proxy instance.

## Failure Diagnostics

Failed scenarios write structured artifacts to:

```text
tests/reports/artifacts/<runId>/<scenarioId>/
```

Current artifact files:

- `response.json`
- `assertions.json`
- `request-logs.json`
- `routing-decisions.json`

## How New Features Get Added To The Framework

Rules:

- changes under `src/translators/` require unit tests
- changes under `src/routes/messages-route.js` require at least one `claude-code` protocol scenario update or addition
- changes under `src/routes/responses-route.js` or `src/routes/codex-route.js` require at least one `codex` protocol scenario update or addition
- changes to routing or model mapping should add request-log or routing-decision assertions

In practice, new features should usually be added by:

1. adding or updating a JSON scenario
2. adding any new assertion helper only if absolutely necessary

## Execution Modes

### Local

```bash
npm run test:unit
npm run test:e2e:protocol:list
npm run test:e2e:protocol
```

If the target service is actively being used and has live routing bindings enabled, the
protocol runner now refuses to mutate settings by default. In that case:

- use a dedicated test instance on a different port, or
- rerun explicitly with `--allow-live-mutations`

Example:

```bash
node tests/e2e/lib/scenario-runner.js --base-url http://127.0.0.1:8082
```

To run against a temporary isolated instance that reuses the configured upstream accounts
but keeps local settings and imported CLI credential files separate:

```bash
npm run test:e2e:protocol:isolated
npm run test:e2e:cli:isolated
npm run test:e2e:isolated
```

Or target a single scenario:

```bash
node tests/e2e/lib/run-isolated-protocol.js --scenario codex-responses-basic
```

The isolated runner currently:

- copies the live config directory into `.test-config/`
- starts a temporary proxy instance on an available local port
- points that instance at copied `Codex` and `Claude Code` credential files via environment variables
- reuses the same upstream accounts and providers already configured in the real environment
- restores the temporary instance settings before shutdown

CLI smoke can use the same isolated instance strategy:

```bash
npm run test:e2e:cli:isolated
```

To run the full isolated regression stack in one command:

```bash
npm run test:e2e:isolated
```

or, only if you intentionally accept the risk:

```bash
node tests/e2e/lib/scenario-runner.js --allow-live-mutations
```

### CI

Recommended split:

- PR: unit + protocol scenarios
- nightly or self-hosted: unit + protocol + CLI smoke

## Why This Design

This design keeps the framework:

- separate from normal runtime execution
- strict enough to catch routing and protocol regressions
- small enough to implement incrementally
- extensible through scenario files instead of hardcoded test scripts

## Current Completion Status

The framework is now in a usable phase-2 state:

- isolated protocol runner implemented
- isolated CLI smoke runner implemented
- failure reports and artifacts implemented
- Codex and Claude Code real CLI smoke paths validated
- live user config and live proxy instance left untouched by isolated runs

The remaining work is incremental expansion:

- add more provider/model matrix scenarios when a new routing path is introduced
- add new CLI smoke cases only for especially important real-client behaviors
- keep most coverage in protocol scenarios, not in fragile CLI automation
