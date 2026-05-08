# Product Manual

## Overview

CliGate is a local AI gateway that sits between developer tools, agent runtimes, channel workflows, and upstream model providers.

It currently combines these capability groups:

- protocol translation for Claude Code, Codex CLI, Gemini CLI, and OpenClaw
- account pools and API key routing
- app-level routing and model mapping
- dashboard chat and product-assistant flows
- Codex and Claude Code runtime sessions in the dashboard
- Telegram and Feishu channel gateways
- request logs, usage, pricing, API exploration, and tool setup
- optional local runtime routing for on-device models

CliGate runs locally by default. In the common path, you start the service, add one usable credential, configure one client, and verify behavior from the dashboard.

## Quick Start

### Start the service

Run one of these:

1. `npx cligate@latest start`
2. `cligate start`

The default dashboard address is:

`http://localhost:8081`

### Recommended first-time setup

1. Start CliGate.
2. Open the dashboard.
3. Add at least one working account, API key, or local runtime.
4. Open `Chat` and verify a model.
5. Open `Settings` and use one-click config for the CLI tool you want to proxy.
6. If you use Telegram or Feishu, configure `Channels` after the core path is working.

## Dashboard Navigation

The current dashboard is organized around work areas rather than a single settings page.

### Workbench

#### Dashboard

Use `Dashboard` for a high-level readiness view:

- linked and available account counts
- active plan and token state
- quick navigation to accounts, chat, tools, and logs
- one-click setup entry points for supported CLI tools

#### Chat

`Chat` is the main interactive verification surface.

You can use it in two modes:

- assistant chat mode for routed model testing
- agent runtime mode for Codex or Claude Code runtime sessions

Key controls include:

- `Chat Source`
- `Model`
- `System Prompt`
- `Product Assistant`
- runtime provider selection when agent runtime mode is enabled

`Product Assistant` prioritizes this manual for product-usage questions. It does not silently rewrite your global routing configuration. Configuration changes still require an explicit action and confirmation path.

#### Assistant Tasks

`Assistant Tasks` is the task-level operational view for runtime work launched through the dashboard.

Use it to inspect:

- task state
- pending clarifications
- pending approvals
- task outputs
- resume and follow-up paths

#### Conversation Records

`Conversation Records` is the inspection surface for persisted channel-linked runtime activity.

Use it when you need to understand:

- what happened in a Telegram or Feishu conversation
- which runtime provider was involved
- whether a task is still active, blocked, or complete

### Assistant

#### Assistant Agent

`Assistant Agent` is the binding and policy area for the assistant-side runtime behavior.

Use it to inspect:

- whether the assistant agent is enabled
- which credential source is bound
- fallback behavior
- circuit-breaker state

### CLI Tools

#### Tool Installer

`Tool Installer` checks for the presence and status of supported local tools and can help install or update them.

This area is intended for:

- Node.js availability checks
- Claude Code / Codex CLI / Gemini CLI / OpenClaw setup
- install/update guidance from the dashboard

### Credentials

#### Accounts

`Accounts` manages:

- ChatGPT accounts
- Claude accounts
- Antigravity accounts

Supported actions include:

- add
- import
- enable or disable
- refresh
- switch
- remove

#### API Keys

`API Keys` manages provider credentials such as:

- OpenAI
- Anthropic
- Azure OpenAI
- Gemini
- Vertex AI
- MiniMax
- Moonshot
- ZhipuAI

Enabled keys can participate in routing and can also be selected directly in `Chat`.

#### Local Models

`Local Models` is the dashboard area for local runtime routing.

Use it to:

- configure a local runtime endpoint
- check runtime health
- refresh discovered models
- expose local models to the routing layer

### Configuration

#### Channels

`Channels` configures Telegram and Feishu providers.

Typical settings include:

- polling or webhook mode
- WebSocket mode for local Feishu desktop setups
- default runtime provider
- working directory
- pairing or approval behavior

#### Routing

`Routing` controls request resolution behavior.

Important concepts:

- `Routing Priority`: account pool first or API key first
- `Routing Mode`: automatic or app-assigned
- `App Assignments`: bind a specific client to a specific credential or local runtime
- `Free Models`: allow supported free-model fallback flows
- `Model Mapping`: resolve requested model IDs to actual upstream models

#### Settings

`Settings` contains one-click configuration flows for supported tools and general server-side options.

The most common use is:

- configure Claude Code for proxy mode
- configure Codex CLI for proxy mode
- configure Gemini CLI for proxy mode
- configure OpenClaw for proxy mode

### Monitoring

#### Usage

`Usage` shows aggregate usage across accounts, providers, and models.

Use it for:

- overview metrics
- daily or monthly trends
- provider-level cost inspection

#### Pricing

`Pricing` is the manual pricing registry and override surface.

Use it to inspect or adjust:

- model pricing entries
- provider pricing assumptions
- manual overrides used in cost views

#### Request Logs

`Request Logs` is the structured history view for request and response traffic.

Use it to inspect:

- request dates
- provider-specific failures
- filtered request histories

#### API Explorer

`API Explorer` is a direct testing panel for local endpoints.

It is useful for:

- protocol verification
- route debugging
- formatting and payload inspection

#### Logs

`Logs` is the rawer server output and live log area.

Use it when request logs are not enough and you need server-side operational context.

### Resources

#### Manual

`Manual` is the lightweight in-product guide available at `/manual/`.

It is a short operational guide for first-time users. The full source-of-truth manuals remain the markdown files in `docs/`.

#### Resources

`Resources` is the curated catalog of free and trial LLM providers available at `/resources/`.

It is read-only and does not change routing behavior by itself.

## Credentials and Minimum Requirements

CliGate needs at least one usable upstream path.

That usually means at least one of:

1. a working ChatGPT account
2. a working Claude account
3. a working Antigravity account
4. a working API key
5. a working local runtime for the requests you intend to send

If none of these are available, routed requests will fail.

## Chat and Product Assistant

### When to use Chat

Use `Chat` when you want to:

- confirm that a credential works
- test a model name
- try a system prompt
- verify that routing is going where you expect
- ask product-usage questions through `Product Assistant`

### What Product Assistant does

When `Product Assistant` is enabled, CliGate prioritizes this manual while answering product-usage questions such as:

- how to configure Claude Code
- how to add API keys
- what routing mode means
- how to disable proxy mode for a tool

### What Product Assistant does not do

- It does not change tool configuration just because you asked a question.
- It does not silently rewrite routing or account settings.
- It does not replace the actual runtime provider you selected for normal chat.

## Tool Configuration

### Claude Code

Use the one-click action in `Settings` to configure Claude Code for proxy mode.

Typical proxy values include:

- `ANTHROPIC_BASE_URL=http://localhost:8081`
- `ANTHROPIC_API_KEY=sk-ant-claude-code-proxy`

You can inspect current state through:

- `GET /claude/config`

### Codex CLI

Use the one-click action in `Settings` to configure Codex CLI.

Typical configuration targets the local endpoints for:

- `chatgpt_base_url`
- `openai_base_url`

You can inspect current state through:

- `GET /codex/config`

### Gemini CLI

Use the one-click setup in `Settings` to apply the required local proxy path and compatibility changes.

You can inspect current state through:

- `GET /gemini-cli/config`

### OpenClaw

Use the one-click setup in `Settings` to configure OpenClaw for CliGate-backed provider access.

You can inspect current state through:

- `GET /openclaw/config`

## Channels and Runtime Sessions

### Supported channel workflows

CliGate supports Telegram and Feishu channel workflows through the `Channels` area and corresponding API routes.

### Runtime session behavior

Once a channel or dashboard conversation is attached to a runtime session, follow-up messages can continue in the same runtime context until the user resets or detaches it.

This is important for:

- continuing a task without restating context
- handling approval requests in sequence
- answering runtime questions without losing the current run

### Typical channel commands

Common operational commands include:

- `/cx <task>` for a fresh Codex session
- `/cc <task>` for a fresh Claude Code session
- `/new` to detach and start fresh on the next message

See the channel-related repository docs for integration details beyond this manual.

## Routing Concepts

### Routing Priority

If both account pools and API key pools are available, `Routing Priority` decides which family is attempted first.

### Routing Mode

Two modes exist:

1. `automatic`
2. `app-assigned`

Use `automatic` when you want CliGate to resolve requests with the normal routing logic.

Use `app-assigned` when you want specific clients to always use a specific credential or local runtime.

### App Assignments

Examples:

- Codex always uses one ChatGPT account
- Claude Code always uses one Claude account
- Gemini CLI always uses one API key
- OpenClaw always uses one local runtime or provider key

### Model Mapping

Model mapping allows the incoming model name and the upstream model name to differ.

This is useful when:

- a client expects one model ID but you want a different upstream target
- you want a stable local-facing model name across provider changes

### Free Models

Free-model routing allows supported requests to resolve to configured free upstream options when that behavior is enabled.

## API and Operational Surfaces

Common API surfaces include:

- `POST /v1/messages`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /backend-api/codex/responses`
- `POST /v1beta/models/*`
- `GET /api/agent-runtimes/providers`
- `GET /api/agent-channels/conversations`
- `GET /api/resources`
- `GET /health`

Use `API Explorer`, `Request Logs`, and `Logs` together when debugging route behavior.

## Common Scenarios

### I only want to verify that a model works

1. Add an account, API key, or local runtime.
2. Open `Chat`.
3. Select a source.
4. Enter a model.
5. Send a simple prompt.

### I want Claude Code to use the local proxy

1. Make sure CliGate is running.
2. Open `Settings`.
3. Run the one-click Claude Code configuration.
4. Confirm the action if prompted.
5. Start Claude Code.

### I want to route each tool differently

1. Open `Routing`.
2. Set `Routing Mode` to `app-assigned`.
3. Configure `App Assignments`.
4. Verify behavior in `Chat`, `API Explorer`, or the relevant client.

### I want mobile or channel-based runtime operations

1. Confirm your core routing works from the dashboard first.
2. Open `Channels`.
3. Configure Telegram or Feishu.
4. Set the default runtime provider and working directory.
5. Use `Conversation Records` to inspect ongoing execution.

## Troubleshooting

### The dashboard does not open

Check:

1. the service is running
2. the port is reachable locally
3. the expected address is `http://localhost:8081`

### Chat requests fail

Check:

1. at least one valid upstream credential or runtime exists
2. the selected source is still enabled
3. the selected model is accepted by the effective upstream provider

### A CLI tool is not using CliGate

Check:

1. the tool was configured from `Settings`
2. the tool-specific config endpoint reflects proxy mode
3. CliGate is running on the expected local port

### Product Assistant gives an incomplete answer

Product Assistant answers from the product manual context. If something is not stated clearly here, the expected behavior is to say that the manual does not provide the answer rather than invent implementation details.

## Important Notes

1. Product Assistant is guidance, not an implicit execution path.
2. Runtime workflows and assistant workflows are not the same as ordinary chat completions.
3. Dashboard documentation, repository docs, and screenshots should be kept in sync when the UI changes.
