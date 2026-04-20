# DingTalk Channel Integration Plan

## Goals

- Preserve the existing Telegram and Feishu channel flows without behavior regressions.
- Fix the current gap where `requirePairing` is configured per channel but not enforced dynamically.
- Introduce a minimal provider catalog foundation so future channels can be added with less UI and settings duplication.
- Prepare the codebase for a DingTalk text-first MVP that reuses the current supervisor, router, runtime session, and outbound dispatcher pipeline.

## Current Architecture Summary

The existing channel stack is already separated into these layers:

- `agent-channels/providers/*`
  Receives and sends external channel messages.
- `agent-channels/router.js`
  Normalizes inbound messages into channel conversations and routes them to the orchestrator.
- `agent-orchestrator/message-service.js`
  Interprets commands and natural-language follow-up intent, chooses Codex or Claude Code, and manages remembered supervisor context.
- `agent-runtime/session-manager.js`
  Owns runtime sessions and runtime event emission.
- `agent-channels/outbound-dispatcher.js`
  Consumes runtime events and sends mobile-friendly outbound messages back to the channel provider.

This is the correct architectural direction. The remaining issues are mostly configuration and extensibility gaps.

## Issues To Fix Before DingTalk

### 1. Pairing enforcement gap

`requirePairing` exists in channel settings and the dashboard, but the router currently reads a static constructor flag instead of the active channel settings for each inbound request.

Impact:

- The UI implies a safety boundary that may not actually be active.
- Adding DingTalk before fixing this would copy the same security gap into a new channel.

Required fix:

- Make pairing enforcement flow through `routeInboundMessage(message, options)`.
- Each provider must pass `requirePairing` from its own channel settings.

### 2. Provider metadata is too thin

The channel registry only exposes:

- `id`
- `capabilities`

This is enough to start providers, but not enough to build a durable configuration UI.

Required fix:

- Add lightweight provider metadata support, while preserving current API compatibility.
- Metadata should include at least:
  - `id`
  - `label`
  - `capabilities`
  - `configFields`

This is not yet a full schema-driven form system, but it creates the foundation.

## Low-Risk Implementation Phases

### Phase 1. Safety and catalog groundwork

- Fix dynamic `requirePairing` enforcement.
- Extend registry and provider status responses with lightweight metadata.
- Keep existing settings shape and existing dashboard behavior fully compatible.
- Add tests for:
  - pairing required when channel settings enable it
  - pairing not required when disabled
  - provider catalog metadata is exposed without breaking current provider status API

### Phase 2. DingTalk provider MVP

- Add `src/agent-channels/providers/dingtalk-provider.js`
- Add DingTalk webhook route
- Support text inbound and text outbound only
- Reuse:
  - `NormalizedChannelMessage`
  - `AgentChannelRouter`
  - `AgentOrchestratorMessageService`
  - `AgentChannelOutboundDispatcher`

Supported first-release behaviors:

- start runtime task
- continue task
- approve / deny
- answer follow-up question
- status and wrap-up queries
- remembered supervisor follow-up logic

### Phase 3. Dashboard evolution

- Keep current Telegram/Feishu cards working during the transition.
- Introduce provider metadata loading in the backend API.
- Later move the dashboard from hard-coded cards to a provider-driven configuration renderer.

This phase is intentionally deferred until after the safe backend groundwork and DingTalk MVP.

## DingTalk MVP Scope

### Inbound

- Webhook-based text message ingestion
- Sender identity extraction
- Conversation identity extraction
- Signature or timestamp validation
- Translation to `createNormalizedChannelMessage(...)`

### Outbound

- Plain text replies
- Start / approval / question / completed / failed messages
- No rich card dependency for the first release

### Deferred

- Interactive cards
- Button callbacks
- Streaming-like progress summaries
- Advanced tenant-scoped permission controls

## Compatibility Rules

During implementation:

- Do not remove or rename existing Telegram / Feishu settings fields.
- Do not change the existing `/api/agent-channels/providers` response in a breaking way.
- Only add new fields to existing payloads.
- Preserve current runtime routing and outbound event behavior.

## Validation Checklist

- Telegram inbound start/continue flow still works.
- Feishu inbound webhook flow still works.
- Session records still group by runtime session.
- Supervisor brief updates still occur for started/completed/failed events.
- Pairing enforcement now follows the active channel settings.
- Provider status endpoint still returns a compatible payload for the dashboard.

