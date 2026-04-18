# API Reference

## Proxy Endpoints

### Anthropic Messages API

```bash
POST /v1/messages
Content-Type: application/json

{
  "model": "claude-sonnet-4-6",
  "max_tokens": 4096,
  "system": "You are helpful.",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true
}
```

Used by: Claude Code, OpenClaw

### OpenAI Chat Completions API

```bash
POST /v1/chat/completions
Content-Type: application/json

{
  "model": "gpt-5.2",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

Used by: Codex CLI, OpenClaw

### OpenAI Responses API

```bash
POST /v1/responses
```

Used by: Codex CLI (WebSocket upgrade returns 426, then uses HTTPS)

### Codex Internal API

```bash
POST /backend-api/codex/responses
GET  /backend-api/codex/models
```

### Gemini API

```bash
POST /v1beta/models/{model}:generateContent
POST /v1beta/models/{model}:streamGenerateContent
GET  /v1beta/models
```

### Token Counting

```bash
POST /v1/messages/count_tokens
Content-Type: application/json

{
  "messages": [...],
  "tools": [...]
}
```

### Models

```bash
GET /v1/models
GET /models
```

### Health

```bash
GET /health

# Response
{
  "status": "ok",
  "total": 2,
  "active": "user@example.com",
  "accounts": [...]
}
```

---

## ChatGPT Account Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/accounts` | GET | List all accounts |
| `/accounts/status` | GET | Account status summary |
| `/accounts/quota` | GET | Get active account quota |
| `/accounts/quota/all` | GET | Get all account quotas |
| `/accounts/add` | POST | Start OAuth flow |
| `/accounts/add/manual` | POST | Manual OAuth code input |
| `/accounts/switch` | POST | Switch active account |
| `/accounts/import` | POST | Import from Codex CLI |
| `/accounts/refresh` | POST | Refresh active account token |
| `/accounts/refresh/all` | POST | Refresh all tokens |
| `/accounts/:email/refresh` | POST | Refresh specific account |
| `/accounts/:email/toggle` | PUT | Enable/disable account |
| `/accounts/:email` | DELETE | Remove account |
| `/accounts/oauth/cleanup` | POST | Clean up OAuth servers |

## Claude Account Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/claude-accounts` | GET | List all Claude accounts |
| `/claude-accounts/status` | GET | Account status summary |
| `/claude-accounts/add` | POST | Start Claude OAuth flow |
| `/claude-accounts/add/manual` | POST | Manual OAuth code input |
| `/claude-accounts/switch` | POST | Switch active account |
| `/claude-accounts/import` | POST | Import from Claude Code |
| `/claude-accounts/refresh` | POST | Refresh active account token |
| `/claude-accounts/refresh/all` | POST | Refresh all tokens |
| `/claude-accounts/:email/refresh` | POST | Refresh specific account |
| `/claude-accounts/:email/toggle` | PUT | Enable/disable account |
| `/claude-accounts/:email` | DELETE | Remove account |
| `/claude-accounts/oauth/cleanup` | POST | Clean up OAuth servers |

---

## CLI Configuration

### Claude Code

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/claude/config` | GET | View current config |
| `/claude/config/proxy` | POST | Configure proxy mode |
| `/claude/config/direct` | POST | Restore direct API |
| `/claude/config/set` | POST | Set custom API endpoint |

### Codex CLI

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/codex/config` | GET | View current config |
| `/codex/config/proxy` | POST | Configure proxy mode |
| `/codex/config/direct` | POST | Restore direct connection |

### Gemini CLI

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/gemini-cli/config` | GET | View current config |
| `/gemini-cli/config/proxy` | POST | Patch Gemini CLI for proxy |
| `/gemini-cli/config/direct` | POST | Remove proxy patch |

### OpenClaw

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/openclaw/config` | GET | View current config |
| `/openclaw/config/proxy` | POST | Configure proxy provider |
| `/openclaw/config/direct` | POST | Remove proxy provider |

---

## Settings

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/settings/haiku-model` | GET | Get current haiku/free model |
| `/settings/haiku-model` | POST | Set haiku/free model target |
| `/settings/kilo-models` | GET | List available free models |
| `/settings/account-strategy` | GET | Get account rotation strategy |
| `/settings/account-strategy` | POST | Set strategy (random/sequential) |
| `/settings/routing-priority` | GET | Get routing priority |
| `/settings/routing-priority` | POST | Set priority (account-first/apikey-first) |

## API Key Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/keys` | GET | List all API keys |
| `/api/keys` | POST | Add new API key |
| `/api/keys/:id` | PUT | Update API key |
| `/api/keys/:id` | DELETE | Remove API key |
| `/api/keys/:id/validate` | POST | Validate API key |
| `/api/keys/stats` | GET | Get key usage stats |

## Usage & Analytics

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/usage/overview` | GET | Usage overview |
| `/api/usage/history` | GET | Usage history |
| `/api/usage/daily` | GET | Daily stats |
| `/api/usage/monthly` | GET | Monthly stats |
| `/api/usage/providers` | GET | Per-provider stats |
| `/api/usage/models` | GET | Per-model stats |
| `/api/usage/accounts` | GET | Per-account stats |

## Pricing

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/pricing` | GET | List pricing summary and effective pricing entries |
| `/api/pricing` | PUT | Update a pricing override |
| `/api/pricing/reset` | POST | Reset one pricing override to defaults |

## Request Logs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/request-logs` | GET | Get request logs |
| `/api/request-logs/dates` | GET | Get available log dates |
| `/api/request-logs/settings` | GET | Get log settings |
| `/api/request-logs/settings` | PUT | Update log settings |

## Model Mapping

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/model-mappings` | GET | Get all model mappings |
| `/api/model-mappings/provider/:provider` | PUT | Set provider mapping |
| `/api/model-mappings/reset` | POST | Reset to defaults |
| `/api/model-mappings/resolve` | GET | Resolve a model name |

## Resources Catalog

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/resources` | GET | List curated resource entries with filters |
| `/api/resources/summary` | GET | Get resource catalog summary |
| `/api/resources/:id` | GET | Get one resource entry |

## Local Runtime Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/local-runtimes` | GET | Get local runtime status and configured runtimes |
| `/api/local-runtimes/ollama-local` | PUT | Update the built-in Ollama runtime config |
| `/api/local-runtimes/enabled` | POST | Enable or disable local model routing |
| `/api/local-runtimes/check` | POST | Check local runtime health |
| `/api/local-runtimes/refresh-models` | POST | Refresh discovered local models and routing targets |

## Agent Runtime Orchestrator

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/agent-runtimes/providers` | GET | List runtime providers available to the dashboard and channels |
| `/api/agent-runtimes/sessions` | GET | List runtime sessions |
| `/api/agent-runtimes/sessions` | POST | Create a runtime session |
| `/api/agent-runtimes/sessions/:id` | GET | Get runtime session detail |
| `/api/agent-runtimes/sessions/:id/stream` | GET | Stream runtime session events |
| `/api/agent-runtimes/sessions/:id/input` | POST | Send follow-up input to a runtime session |
| `/api/agent-runtimes/sessions/:id/approval` | POST | Resolve an approval request |
| `/api/agent-runtimes/sessions/:id/question` | POST | Answer a runtime question |
| `/api/agent-runtimes/sessions/:id/cancel` | POST | Cancel a runtime session |

## Agent Channel Gateway

Feishu supports two connection models:
- `websocket` for local desktop deployments without a public callback URL
- `webhook` for server deployments with a public HTTPS callback endpoint

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/agent-channels/providers` | GET | List channel provider status |
| `/api/agent-channels/settings` | GET | Get channel settings |
| `/api/agent-channels/settings/:channel` | PUT | Update channel settings |
| `/api/agent-channels/refresh` | POST | Refresh channel providers |
| `/api/agent-channels/feishu/webhook` | POST | Receive Feishu webhook events |
| `/api/agent-channels/session-records` | GET | List channel-linked runtime session records used by Conversation Records |
| `/api/agent-channels/session-records/:id` | GET | Get one channel-linked runtime session record |
| `/api/agent-channels/conversations` | GET | List stored channel conversation threads |
| `/api/agent-channels/conversations/:id` | GET | Get one stored channel conversation with deliveries |
| `/api/agent-channels/conversations/:id/reset` | POST | Detach the active runtime session from a conversation |
| `/api/agent-channels/pairing/:channel/:conversationId/approve` | POST | Approve channel pairing |
| `/api/agent-channels/pairing/:channel/:conversationId/deny` | POST | Deny channel pairing |

## Tool Installer

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/tools/status` | GET | Get tool installation and version status |
| `/api/tools/node-info` | GET | Get Node.js installation info |
| `/api/tools/install/:toolId` | POST | Install one CLI tool |
| `/api/tools/install-node` | POST | Install Node.js for the current platform |
| `/api/tools/launch/:toolId` | POST | Launch an installed tool |

## API Gateway

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/gateway/chat` | POST | External chat via API key |
| `/api/gateway/messages` | POST | External messages via API key |
| `/api/gateway/providers` | GET | List available providers |

---

## Error Responses

### Authentication Error

```json
{
  "type": "error",
  "error": {
    "type": "authentication_error",
    "message": "No active account with valid credentials"
  }
}
```

### Rate Limit Error

```json
{
  "type": "error",
  "error": {
    "type": "rate_limit_error",
    "message": "Rate limited: retry after 30s"
  }
}
```

## Streaming (Anthropic SSE Format)

```
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{...}}

event: message_stop
data: {"type":"message_stop"}
```
