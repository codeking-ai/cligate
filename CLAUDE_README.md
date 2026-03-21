# CLAUDE.md
# ProxyPool Hub - AI Agent Instructions

## Welcome Claude Code
You are an autonomous agent running inside the `proxypool-hub` repository via an OpenClaw bot. This file provides the core context and operational instructions for your task.

### Your Mission
Your goal is to independently investigate the project, find an area for improvement, and **add a valuable feature**, **fix a bug**, or **enhance the proxy's functionality**. The aim is to make the proxy robust, feature-rich, and capable of long-term survival.

This file provides guidance to Claude Code (`claude.ai/code`) when working with code in this repository. You are an autonomous agent tasked by OpenClaw to analyze and systematically improve this codebase based on these instructions.

for more context or if have any doubt related to project check our prject doc at proxypool-hub/docs

## Project Overview

**ProxyPool Hub** is a local proxy server (`localhost:8081`) that translates Anthropic API requests from the Claude Code CLI into ChatGPT's internal Codex Responses API format (`chatgpt.com/backend-api/codex/responses`). It enables users to run Claude Code natively using their ChatGPT Free/Plus/Pro accounts, fully supporting native tool calling, streaming, and account management.

The proxy bypasses Cloudflare protections, translates Anthropic formatted requests into flat `function_call` payload arrays, and seamlessly orchestrates credentials by dynamically injecting active tokens into `~/.claude/settings.json` or `~/.codex/auth.json`. 

## Commands

```bash
# Core server operations
npm install                 # Install dependencies
npm start                   # Start the proxy (port 8081)

# Account Management (Interactive & Headless CLI)
npm run accounts            # Interactive account prompt
npm run accounts:add            # Desktop: Opens browser to login
npm run accounts:add:headless   # Headless: Generates URL for manual PKCE code entry
npm run accounts:list           # List configured ChatGPT accounts
npm run accounts:remove         # Remove an account
npm run accounts:verify         # Trigger background token validation

# Testing Suite (Run server first to run all HTTP API tests)
npm test                    # Run all tests
npm run test:unit           # Run unit tests only
npm run test:api            # Run API integration tests
npm run test:routing        # Run routing integration tests
npm run test:cors           # Run CORS security tests
npm run test:ui             # Run Web UI tests
```

## Architecture

**Request Flow:**
```
Claude Code CLI → Express Server (server.js) → Format Converter → ChatGPT Codex API
```

**Directory Structure:**
```
src/
├── index.js                    # CLI entrypoint
├── server.js                   # Express server base configuration
├── account-manager.js          # Core token refresh, switching, and OAuth limits logic
├── claude-config.js            # Reads/Writes config to ~/.claude/settings.json
├── direct-api.js               # Main HTTP Client to ChatGPT's backend (`/codex/responses`)
├── format-converter.js         # Core Anthropic ↔ OpenAI Format Transformation
├── response-streamer.js        # Parses target OpenAI SSE events into Anthropic SSE frames
├── middleware/                 # Request pipeline authentication & origin validation
├── routes/                     # Modulized API routing (e.g., api-routes.js)
├── utils/                      # Helper scripts 
├── model-api.js                # Fetches models/usage stats/quotas
├── model-mapper.js             # Maps `claude-sonnet-4-5` to `gpt-5.2` etc.
├── oauth.js                    # OAuth 2.0 PKCE authentication flow
├── kilo-api.js                 # Alternate upstream client
├── kilo-format-converter.js    # OpenRouter/Anthropic ↔ OpenAI Chat format
├── kilo-streamer.js            # Alternate upstream SSE adapter
└── server-settings.js          # Server configuration overrides

public/
├── index.html                  # Main Web UI application
├── js/
│   └── app.js                  # Frontend logic (Dashboard, settings overrides etc)
└── css/
```

**Key Modules & Mechanics:**

- **src/format-converter.js**: Handles unnesting Anthropic `tool_use`/`tool_result` array objects from message contents into the discrete top-level `function_call` structure demanded by ChatGPT's Responses API. Prefixing function call IDs with `fc_`.
- **src/response-streamer.js**: Binds to `response.output_item.added`, `response.completed`, and text delta stream chunks from OpenAI and maps them exactly to `message_start`, `content_block_delta`, and `message_stop` events.
- **src/account-manager.js**: Reads `~/.proxypool-hub/` and proactively background-refreshes OAuth refresh tokens exactly 5 minutes before the 1hr expiry deadline.
- **src/model-mapper.js**: Performs translation like `claude-opus-4-5` → `gpt-5.3-codex`. Supports `/settings/haiku-model` overrides which swap the OpenRouter backbone for Haiku endpoints (like `kimi-k2.5`).
- **src/oauth.js**: Coordinates PKCE challenge mechanisms via local port 1455. Generates URIs and exchanges OAuth codes headlessly.

## Execution Rules (Strictly Follow)

You are being invoked via a daily Cron by OpenClaw to continuously evolve this project.

1. **Analyze First:** Examine the source code above carefully. Pick **ONE** substantial enhancement, feature addition, technical debt repair, or major bug fix to execute. 
*(Ideas: Add fallback mechanisms on rate-limits, implement token bucket load-balancing, enhance UI functionality, refactor legacy API handlers, or Improve more on your ideas).*
2. **Implement:** Write maintainable modular ES6 JavaScript. Add JS doc comments. Always put imports at the top. Split large files if they exceed 800 LOC. Adhere to internal structures (e.g. keeping express routing modularized), research about what you are implementing ex. if you implementing rate limit feature then find out how Rate limit error hits on Chatgpt apis etc .
3. **Update Documentation:** ALWAYS document what you did in the `## Enhancements and Features` section inside this very Markdown file. Keep a running changelog of your activities underneath your section.
4. **Agent Handoff:** Once you finish modifying the files, **DO NOT execute `git` commands (no commits, no pushes).** You must terminate your execution cleanly and print a robust, comprehensive formatted digest of what you accomplished to standard output. OpenClaw will capture your stdout, verify it, and perform the Git Commits to the repository automatically based on Ayush's approval.
   * **Note on Feedback:** If Ayush denies or requests changes, OpenClaw will re-invoke you using your previous session ID (`claude -r <session>`) so you retain full context of what you just did. Use that context to fix the issues requested.

---

## Enhancements and Features
*(Claude: Append your changelog entries below this line after completing your task)*

ok