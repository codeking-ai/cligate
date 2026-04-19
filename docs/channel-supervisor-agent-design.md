# Channel Supervisor Agent Design

## Goal

CliGate should not behave like a passive message relay between Telegram / Feishu and runtime providers.
It should behave like a lightweight supervisor agent that:

- accepts user intent from mobile channels
- delegates execution to Codex or Claude Code
- watches runtime progress, approvals, questions, success, and failure
- remembers user preferences and scoped permission decisions
- intervenes only at critical control points

The target behavior is "assistant-like orchestration", not "free-form agent takes over everything".

## Design Principles

### 1. Keep execution deterministic

Codex and Claude Code remain the execution engines.
CliGate should not replace their planning/tool logic.

CliGate should only intervene at explicit control points:

- before starting a runtime task
- when a runtime asks a question
- when a runtime asks for permission
- when a runtime finishes
- when a runtime fails or stalls

### 2. Keep memory structured

We should not rely on free-form prompt history alone.
Supervisor memory must be stored as structured data with clear scope.

### 3. Prefer policy over improvisation

Automatic approval should come from:

- explicit user decisions
- stored scoped rules
- provider-provided permission suggestions

Not from unconstrained model improvisation.

### 4. Ask only when needed

If the supervisor can safely decide from memory and current policy, it should do so.
If not, it should send a human-readable approval request to the user.

## Architecture

The design adds a supervisor layer above the existing runtime orchestration.

```text
Telegram / Feishu
        |
        v
Channel Router
        |
        v
Supervisor Agent Layer
        |
        +--> Memory / Policy Engine
        |
        v
Runtime Session Manager
        |
        +--> Codex
        +--> Claude Code
```

The existing runtime/session manager stays in place.
The supervisor layer is event-driven and does not replace the runtime transport.

## Supervisor Control Points

### A. Task Start

Input:

- user message
- current channel conversation state
- channel default runtime provider
- memory and user preferences

Supervisor responsibilities:

- detect whether the message starts a new task, switches provider, or continues an existing session
- decide which provider to use when needed
- normalize the task phrasing before delegating
- summarize the planned execution to the user when useful

### B. Approval Request

Input:

- runtime approval event
- raw provider request
- session memory
- channel conversation memory

Supervisor responsibilities:

- transform raw approval details into user-readable channel text
- check whether an existing rule already covers this request
- auto-approve when a matching rule exists
- ask the user only if the request falls outside remembered policy

### C. Question Request

Input:

- runtime question / elicitation event
- current task summary

Supervisor responsibilities:

- reframe the question in channel-friendly language
- accept direct natural-language answers from the user
- map the answer back into provider control input

### D. Task Completed / Failed

Supervisor responsibilities:

- summarize outcome
- highlight key file paths, artifacts, and next steps
- explain failures in plain language
- suggest corrective action only when needed

## Memory Model

Supervisor memory should be layered by scope.

### 1. Session Scope

Tied to one runtime session.
Used for temporary permissions and temporary user preferences.

Examples:

- allow `Read` on `D:\lovetoday\**` for this session
- allow `Bash` mkdir under `D:\lovetoday` for this session

### 2. Channel Conversation Scope

Tied to one Telegram / Feishu conversation.
Survives runtime session replacement within the same mobile thread.

Examples:

- this conversation prefers Claude Code by default
- this conversation uses concise Chinese status summaries
- allow repeated work inside `D:\lovetoday\**` during this thread

### 3. Global User Scope

Optional future stage.
Used for broad user preferences, not broad dangerous permissions.

Examples:

- prefer Claude Code for UI work
- prefer Codex for command-line tasks
- always reply in Chinese

## Permission Policy Model

Approval rules should be stored as structured policy records.

Suggested schema:

```json
{
  "id": "uuid",
  "scope": "session",
  "scopeRef": "runtime-session-id",
  "provider": "claude-code",
  "toolName": "Read",
  "decision": "allow",
  "pathPatterns": ["D:\\lovetoday\\**"],
  "commandPrefixes": [],
  "createdAt": "2026-04-19T14:08:20.643Z",
  "createdBy": "user"
}
```

For Bash-like tools we may also store command prefixes:

```json
{
  "toolName": "Bash",
  "commandPrefixes": [
    "mkdir -p \"/d/lovetoday\""
  ]
}
```

### Matching rules

The supervisor should match from narrowest to broadest:

1. exact tool + exact command prefix
2. tool + path pattern
3. provider + path pattern

Default should remain deny / ask-user when nothing matches.

## Natural Language Approval Handling

The channel experience should not require command memorization for every approval.

### Supported direct approval intents

These should resolve the current pending approval immediately:

- `同意`
- `可以`
- `允许`
- `继续`
- `approve`
- `ok`
- `okay`
- `yes`
- `y`

### Supported direct denial intents

- `拒绝`
- `不行`
- `deny`
- `no`
- `n`
- `停止`

### Supported policy-grant intents

These should both approve the current request and persist a scoped rule:

- `同意这个目录后续所有操作`
- `这个会话里 D:\\lovetoday 下面都允许`
- `允许这个目录下的读写`
- `这个会话后续同类操作别再问我`

For phase 1, we should support rule extraction through deterministic parsing plus provider hints:

- use `permission_suggestions`
- use `blocked_path`
- use `tool_name`

Only if deterministic extraction fails should we later consider LLM-assisted policy extraction.

## Human-readable Approval Messages

Raw approval events from Claude Code already contain enough detail.
The supervisor should turn them into structured channel text.

Example:

```text
Claude Code wants permission to use Bash

Purpose:
Create lovetoday directory on D drive

Command:
mkdir -p "/d/lovetoday"

Blocked path:
D:\lovetoday

Suggested session rule:
- allow D:\ for this session
- switch session mode to acceptEdits

Reply with:
- 同意 / approve / ok
- 拒绝 / deny / no
- 本会话允许该目录后续操作
```

## Implementation Plan

### Phase 1: Mobile-friendly approvals

Deliverables:

- human-readable Claude Code approval messages
- natural-language approve / deny parsing
- session-scoped approval memory
- automatic approval when a remembered rule matches

Files expected to change:

- `src/agent-runtime/providers/claude-code-provider.js`
- `src/agent-runtime/approval-service.js`
- `src/agent-orchestrator/message-service.js`
- `src/agent-channels/formatter.js`
- `src/agent-channels/conversation-store.js`
- `src/agent-channels/outbound-dispatcher.js`

New files:

- `src/agent-runtime/approval-policy-store.js`
- `src/agent-runtime/approval-policy.js`

### Phase 2: Supervisor summaries and task memory

Deliverables:

- task objective memory
- richer completion / failure summaries
- provider choice hints

### Phase 3: Supervisor strategy selection

Deliverables:

- choose Codex vs Claude Code based on task profile
- retry / recover policies
- optional global preference memory

## Security Boundaries

The supervisor must never silently create broad permanent allow rules for dangerous tools.

Defaults:

- `Read` / `Write` / `Edit`: session-scoped memory is acceptable when the path is specific
- `Bash`: session-scoped memory only, unless the user explicitly broadens scope
- no global permanent auto-allow for arbitrary shell commands in phase 1

## Best-practice Recommendation

The best near-term product path is:

1. keep Codex and Claude Code as deterministic executors
2. add a small event-driven supervisor layer
3. use structured memory for permissions and preferences
4. let the supervisor auto-handle repeated safe approvals inside a session
5. ask the user only when policy does not already cover the request

This gives CliGate the behavior of a practical assistant without turning it into an opaque agent that is hard to trust or debug.
