# CliGate

![CliGate Dashboard](./images/dashboard.png)

[![AGPL-3.0 License](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js Version](https://img.shields.io/badge/Node.js-24%2B-blue.svg)](https://nodejs.org/)
[![npm Version](https://img.shields.io/npm/v/cligate)](https://www.npmjs.com/package/cligate)
[![GitHub stars](https://img.shields.io/github/stars/codeking-ai/cligate?style=social)](https://github.com/codeking-ai/cligate)

**[English](./README.md) | [中文](./README_CN.md)**

CliGate is a local AI control plane built around two core capabilities:

- **Assistant**: a resident private assistant that stays available in the background, understands user tasks, remembers context, uses tools, schedules work, operates channels, and can execute actions through MCP, skills, desktop automation, shell/file tools, or delegated runtimes.
- **Model Proxy**: one local API and model-routing layer for Claude Code, Codex CLI, Gemini CLI, OpenClaw, and API-compatible clients, with unified accounts, API keys, model mapping, logs, usage, and cost visibility.

It keeps both layers local-first on `localhost`: the assistant acts like a personal operator for real tasks, while the proxy owns provider access, routing, credentials, unified model names, and observability.

## Why CliGate

- One local dashboard for a resident private assistant and unified model routing
- Assistant tasks with memory, approvals, follow-ups, scheduled work, channels, and tool execution
- Account pools, API keys, local runtimes, app routing, and model mapping in one proxy layer
- Channels for Telegram, Feishu, and DingTalk workflows
- Local-first deployment without a hosted relay

## What It Includes

### Assistant

- Dashboard chat and Assistant Tasks for personal task execution
- A persistent assistant agent with task records, memory, policies, approvals, and resumable executions
- Tool execution through skills, MCP, shell/file tools, scheduled tasks, channels, and optional desktop automation
- Optional delegation to Codex / Claude Code runtime sessions when a task needs an external coding agent
- Telegram, Feishu, and DingTalk channel workflows

### Model Proxy

- Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, Codex, and Gemini-compatible endpoints
- One-click configuration for Claude Code, Codex CLI, Gemini CLI, and OpenClaw
- ChatGPT, Claude, and Antigravity account pools
- API key pools for OpenAI, Azure OpenAI, Anthropic, Gemini, Vertex AI, MiniMax, Moonshot, ZhipuAI, DeepSeek, Qwen, and OpenRouter
- Routing priority, app-level bindings, provider model mapping, and free-model routing
- Optional local model routing through Ollama-style runtimes

### Observability and operations

- Usage and pricing views
- Request logs and live log streaming
- API explorer
- Tool installer and CLI config helpers
- Resources catalog for free/trial model providers

## Quick Start

### 1. Start CliGate

```bash
npx cligate@latest start
```

Or install globally:

```bash
npm install -g cligate
cligate start
```

Or use a desktop release package:

1. Download the installer or app package for your platform from [Releases](https://github.com/codeking-ai/cligate/releases).
2. Install or open the package, then launch `CliGate`.
3. CliGate will start the local service and open the desktop window automatically.

Default dashboard:

`http://localhost:8081`

### 2. Add at least one working credential

Use the dashboard:

- `Accounts` for ChatGPT / Claude / Antigravity
- `API Keys` for provider keys
- `Local Models` for on-device runtimes

### 3. Choose your first path

For Assistant use, open `Chat` or `Assistant Tasks` and tell the private assistant what you want done.

For Model Proxy use, point a CLI tool or API-compatible client to CliGate.

Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8081
export ANTHROPIC_API_KEY=any-key
claude
```

Codex CLI:

```toml
# ~/.codex/config.toml
chatgpt_base_url = "http://localhost:8081/backend-api/"
openai_base_url = "http://localhost:8081"
```

Gemini CLI and OpenClaw can also be configured from the dashboard.

## User Paths

### Assistant users

Use `Chat`, `Assistant Tasks`, `Conversation Records`, `Scheduled`, `Skills`, `MCP`, and channels to ask the resident assistant to execute real tasks, remember context, use tools, send follow-ups, and keep working in the background.

### Model Proxy users

Start the service, add one credential, run one-click config, and send your first proxied request from Claude Code, Codex CLI, Gemini CLI, OpenClaw, or an API-compatible client.

### Dashboard operators

Use the dashboard to manage accounts, API keys, routing priority, model mapping, local runtimes, pricing, request logs, usage, channel settings, skills, MCP, and desktop-agent settings.

## Documentation

Start here if you want the shortest path to the right document:

- [Documentation Hub](./docs/README.md)
- [Product Manual (English)](./docs/product-manual.en.md)
- [Product Manual (Chinese)](./docs/product-manual.zh-CN.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [API Reference](./docs/API.md)
- [App Routing](./docs/APP_ROUTING.md)
- [Accounts](./docs/ACCOUNTS.md)
- [OpenClaw Integration](./docs/OPENCLAW.md)
- [Screenshot Guide](./docs/SCREENSHOTS.md)
- [Release Guide](./docs/RELEASING.md)
- [Community](./docs/COMMUNITY.md)
- [Contributing](./CONTRIBUTING.md)
- [Security](./SECURITY.md)
- [Support](./SUPPORT.md)
- [Changelog](./CHANGELOG.md)

After the server starts, a lightweight product guide is also available at:

- `http://localhost:8081/manual/`
- `http://localhost:8081/resources/`

## Local Architecture

```text
Assistant Surfaces
  Web Chat / Assistant Tasks / Telegram / Feishu / DingTalk / Scheduled Tasks
           |
           v
Private Assistant and Tools
  Memory / Policies / Skills / MCP / Desktop Agent / Shell + File Tools / Optional Codex + Claude Code Delegation
           |
           v
CliGate Local Control Plane (localhost:8081)
           |
           +--> Model Proxy
           |    - Protocol translation
           |    - Account and API key routing
           |    - App-level bindings and model mapping
           |    - Local model routing
           |
           v
Upstream Providers and Local Runtimes
  OpenAI / Anthropic / Gemini / Vertex AI / Kilo / Ollama / others
```

## API Surface

| Endpoint | Use |
|:--|:--|
| `POST /v1/messages` | Anthropic Messages proxy |
| `POST /v1/chat/completions` | OpenAI Chat Completions proxy |
| `POST /v1/responses` | OpenAI Responses proxy |
| `POST /backend-api/codex/responses` | Codex internal compatibility |
| `POST /v1beta/models/*` | Gemini CLI proxy |
| `GET /api/agent-runtimes/providers` | Runtime provider catalog |
| `GET /api/agent-channels/conversations` | Channel conversation records |
| `GET /api/assistant/tasks` | Assistant task records |
| `GET /api/assistant/mcp/servers` | MCP server management |
| `GET /api/assistant/skills` | Assistant skill management |
| `GET /api/desktop-agent/status` | Desktop-agent status |
| `GET /api/local-runtimes` | Local runtime status |
| `GET /api/resources` | Resource catalog |
| `GET /health` | Health and version |

See [docs/API.md](./docs/API.md) for more detail.

## Community

- [GitHub Discussions](https://github.com/codeking-ai/cligate/discussions)
- [Issues](https://github.com/codeking-ai/cligate/issues)
- [Discord](https://discord.gg/GgxZSehxqG)
- [X](https://x.com/GengSteven58767)
- [Community Guide](./docs/COMMUNITY.md)
- [Releases](https://github.com/codeking-ai/cligate/releases)


If you plan to contribute, read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## License

This project is licensed under [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0).

## Disclaimer

CliGate is an independent open-source project and is not affiliated with Anthropic, OpenAI, Google, or other upstream providers.
