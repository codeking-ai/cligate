# Product Manual

## Overview

CliGate is a local AI control plane with two heavyweight capabilities:

1. **Assistant** is a resident private assistant that stays available in the background, understands user tasks, remembers context, uses tools, schedules work, operates channels, and can execute actions through MCP, skills, desktop automation, shell/file tools, or delegated runtimes.
2. **Model Proxy** provides one local API and model-routing layer for AI coding tools and API-compatible clients, backed by local credentials, provider mappings, logs, usage, and cost controls.

The Assistant side includes dashboard chat, Assistant Tasks, task records, executions, memory, policies, approvals, clarifications, channel conversations, scheduled work, skills, MCP tools, shell/file tools, optional desktop-agent tools, and optional delegation to Codex / Claude Code runtime sessions.

The Model Proxy side includes protocol translation for Claude Code, Codex CLI, Gemini CLI, OpenClaw, and API-compatible clients; ChatGPT / Claude / Antigravity account pools; API key routing; app-level bindings; model mapping; free-model routing; local runtime routing; request logs; usage; pricing; API exploration; and one-click tool setup.

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
5. For Assistant use, open `Chat` or `Assistant Tasks` and tell the private assistant what you want done.
6. For Model Proxy use, open `Settings` and use one-click config for the CLI tool you want to proxy.
7. If you use Telegram, Feishu, or DingTalk, configure `Channels` after the core path is working.

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

`Chat` is the main interactive surface for both the resident Assistant and Model Proxy verification.

You can use it in two modes:

- model chat mode for routed model testing
- smart assistant mode for asking the resident assistant to plan, use tools, run tasks, or delegate work

Key controls include:

- `Chat Source`
- `Model`
- `System Prompt`
- `Product Assistant`
- assistant routing and runtime controls when smart assistant mode is enabled

`Product Assistant` prioritizes this manual for product-usage questions. It does not silently rewrite your global routing configuration. Configuration changes still require an explicit action and confirmation path.

#### Assistant Tasks

`Assistant Tasks` is the task-level operational view for work owned by the resident Assistant, whether it was launched through the dashboard, channels, scheduled tasks, or an internal handoff.

Use it to inspect:

- task state
- pending clarifications
- pending approvals
- task outputs and execution history
- resume and follow-up paths

#### Conversation Records

`Conversation Records` is the inspection surface for persisted channel-linked runtime activity.

Use it when you need to understand:

- what happened in a Telegram, Feishu, or DingTalk conversation
- which assistant task or runtime provider was involved
- whether a task is still active, blocked, or complete

### Assistant

#### Assistant Agent

`Assistant Agent` is the binding and policy area for the resident Assistant.

Use it to inspect:

- whether the assistant agent is enabled
- which credential source is bound
- fallback behavior
- circuit-breaker state
- autonomy, confirmation, and execution boundaries

#### Skills

`Skills` manages local assistant skills.

Use it to:

- inspect discovered skills
- enable or disable skills
- create, import, edit, or remove writable skills

#### MCP

`MCP` manages assistant-side MCP servers, tools, and resources.

Use it to:

- configure MCP servers
- enable, reload, or remove servers
- inspect server tools and resources
- call MCP tools or read MCP resources through the local control plane

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

`Channels` configures Telegram, Feishu, and DingTalk providers.

Typical settings include:

- polling or webhook mode
- WebSocket mode for local Feishu desktop setups
- default runtime provider
- working directory
- pairing or approval behavior

#### Scheduled Tasks

`Scheduled` manages one-shot and recurring work for the resident Assistant.

Scheduled tasks can:

- deliver reminder messages to a selected conversation
- wake the Assistant with an instruction
- optionally run with a working directory
- keep each run fresh or share context across runs

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
- inspect or manage desktop-agent settings when desktop automation is enabled

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

## Assistant

### When to use Assistant

Use the Assistant side when you want to:

- ask a resident private assistant to execute a real task
- keep task context alive across follow-ups, approvals, clarifications, and channels
- inspect task records, executions, and transcripts
- use skills, MCP tools, shell/file tools, or desktop automation in a controlled local workflow
- schedule one-shot or recurring assistant work
- use channel conversations for mobile or team workflows
- delegate to Codex / Claude Code only when that is the right way to complete a coding task
- ask product-usage questions through `Product Assistant`

### What Product Assistant does

When `Product Assistant` is enabled, CliGate prioritizes this manual while answering product-usage questions such as:

- how to configure Claude Code
- how to add API keys
- what routing mode means
- how to disable proxy mode for a tool

Product Assistant is only one mode of the broader Assistant. The broader Assistant is task-oriented: it can create tasks, use tools, remember context, ask for missing information, wait for approval, resume work, and deliver results through the dashboard or channels.

### What Product Assistant does not do

- It does not change tool configuration just because you asked a question.
- It does not silently rewrite routing or account settings.
- It does not replace the actual runtime provider you selected for normal chat.

## Model Proxy

### When to use Model Proxy

Use the Model Proxy side when you want to:

- make Claude Code, Codex CLI, Gemini CLI, OpenClaw, or an API-compatible client use local routing
- share provider access across accounts, API keys, and local runtimes
- bind different apps to different credentials
- map requested model names to upstream model names
- inspect request logs, usage, pricing, and provider failures

### What Model Proxy does

Model Proxy accepts the protocol shape that the client already speaks and resolves where the request should go.

Typical proxy surfaces include:

- Anthropic Messages for Claude Code and compatible clients
- OpenAI Chat Completions
- OpenAI Responses and Codex-compatible endpoints
- Gemini-compatible routes

The client does not need to own your provider strategy. CliGate handles routing, credentials, fallback, logging, and cost visibility locally.

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

CliGate supports Telegram, Feishu, and DingTalk channel workflows through the `Channels` area and corresponding API routes.

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
- `GET /api/assistant/tasks`
- `GET /api/assistant/mcp/servers`
- `GET /api/assistant/skills`
- `GET /api/desktop-agent/status`
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

### I want the Assistant to execute a task

1. Add a credential, local runtime, or tool path that can support the task.
2. Open `Chat` or `Assistant Tasks`.
3. Tell the Assistant what outcome you want.
4. Set a working directory if the task needs project files.
5. Watch approvals, clarifications, tool calls, runtime delegation, and results from the dashboard.

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
3. Configure Telegram, Feishu, or DingTalk.
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
2. Assistant task workflows are not the same as ordinary model proxy completions.
3. Dashboard documentation, repository docs, and screenshots should be kept in sync when the UI changes.
