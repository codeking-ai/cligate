# Architecture

## Overview

```
┌──────────────────┐     ┌─────────────────────┐     ┌────────────────────────────┐
│   Claude Code    │────▶│  This Proxy Server  │────▶│  ChatGPT Codex backend      │
│   (Anthropic     │     │  (Anthropic format) │     │  (internal API)             │
│    API format)   │     │                     │     │                             │
└──────────────────┘     └─────────────────────┘     └────────────────────────────┘
                                   │
                                   ▼
                         ┌─────────────────────┐
                         │  Account Manager    │
                         │  (local storage)    │
                         │                     │
                         └─────────────────────┘
```

## Key Discovery

This proxy forwards requests from Anthropic-compatible clients (like Claude Code) to the ChatGPT Codex backend, handling authentication, format conversion, and streaming.

## Project Structure

```
proxypool-hub/
├── package.json
├── README.md
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API.md
│   ├── OAUTH.md
│   ├── ACCOUNTS.md
│   └── CLAUDE_INTEGRATION.md
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js              # Web UI logic
└── src/
    ├── index.js               # App entrypoint
    ├── server.js              # Express server setup
    ├── routes/api-routes.js   # API route registrations
    └── ...                    # OAuth, accounts, converters, upstream clients
```

(See the `src/` directory for the full implementation; this doc focuses on the high-level shape.)

## Module Responsibilities

| File | Purpose |
|------|---------|
| `index.js` | Entry point (starts server) |
| `server.js` | Express server, routes, request handling (CORS restricted) |
| `routes/api-routes.js` | API route registrations (mounted by server) |
| `oauth.js` | OAuth 2.0 PKCE flow, token exchange |
| `account-manager.js` | Account persistence, switching, token refresh |
| `format-converter.js` | Convert between Anthropic and OpenAI Responses API formats |
| `response-streamer.js` | Parse SSE events, convert to Anthropic streaming format |
| `direct-api.js` | HTTP client for ChatGPT backend |
| `kilo-api.js` | Alternate upstream client |
| `kilo-format-converter.js` | Anthropic ↔ OpenAI Chat conversion |
| `kilo-streamer.js` | Streaming adapter |
| `server-settings.js` | Server-wide settings persistence |
| `model-api.js` | Fetch models, usage, quota |
| `claude-config.js` | Read/write Claude Code settings |

## Data Flow

### Request Flow

1. Claude Code sends Anthropic-format request to `/v1/messages`
2. The proxy maps the requested model to an upstream target
3. If the mapped path requires ChatGPT auth, the account manager loads/refreshes credentials
4. Request is converted and sent upstream
5. Response is streamed back as Anthropic SSE events

### Web UI Account/Quota Flow

1. Web UI loads account list from `/accounts`
2. Web UI fetches quota snapshots from `/accounts/quota/all`
3. Quota values are merged into account rows for table + modal views
4. Remaining quota is rendered from normalized usage percentages
5. On mobile/tablet, sidebar navigation auto-closes after tab change and account table uses horizontal scrolling

### Format Conversion

**Anthropic → OpenAI Responses API:**
- `messages` → `input` array with `type: 'message'`
- `system` → `instructions`
- `tools` → OpenAI function format
- `tool_use` → `function_call` input item
- `tool_result` → `function_call_output` input item

**OpenAI → Anthropic:**
- `output_text` → `{ type: 'text', text: ... }`
- `function_call` → `{ type: 'tool_use', id, name, input }`
- SSE events converted to Anthropic streaming format

## Available Models

| Model | Description |
|-------|-------------|
| `gpt-5.3-codex` | Latest agentic coding model |
| `gpt-5.2-codex` | Frontier agentic coding model |
| `gpt-5.2` | General-purpose frontier model |

## Model Mapping

Claude model names are automatically mapped:

| Claude Model | Codex Model |
|--------------|-------------|
| `claude-opus-4-5` | `gpt-5.3-codex` |
| `claude-sonnet-4-5` | `gpt-5.2` |
| `claude-haiku-4` | routed by server setting |

Haiku routing is controlled by a server-wide setting (`/settings/haiku-model`).

## Data Storage

Account and configuration files are stored under your home directory (platform-specific). See `docs/ACCOUNTS.md` and `docs/CLAUDE_INTEGRATION.md` for details.
