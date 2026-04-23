# CliGate Assistant ReAct Redesign

## Goal

Replace the current rule-driven `/cligate` interaction path with a real LLM-driven supervisor agent that behaves like Claude Code or Codex:

- the user talks to `CliGate Assistant`
- the assistant understands natural language first
- the assistant decides whether to answer directly, inspect state, call tools, or delegate to Codex / Claude Code
- the assistant returns a natural-language reply instead of exposing internal runner templates as the main experience

This redesign does **not** throw away the Phase 4/5/6/7 infrastructure. It repositions those layers as internal execution infrastructure for a real assistant loop.

## Problem Statement

The current implementation has solid control-plane building blocks:

- assistant session / run
- runtime session / turn / event
- task view
- memory / policy
- tool registry / executor

But the `/cligate` entry path is still centered on:

- rule classification
- fixed planner intents
- deterministic tool sequences
- template-heavy accepted / status / summary responses

That means the architecture direction is mostly right, but the user-facing interaction shape is still wrong for the original vision.

## Target Interaction

### What `/cligate` should feel like

The user should feel they are talking to a supervisor assistant, not a task router.

Examples:

- `/cligate 你是谁`
  - assistant replies directly in natural language
- `/cligate 帮我看一下这个仓库的登录问题`
  - assistant may inspect task/runtime state first
  - assistant may decide to delegate to Codex or Claude Code
  - assistant later replies with a natural-language summary
- `/cligate 现在卡在哪`
  - assistant reads unified task view and runtime context
  - assistant answers using task semantics, not raw store structure

### What remains internal

The following remain internal infrastructure:

- task view
- observation service
- memory / policy
- tool registry
- runtime delegation
- turn / event drill-down

The assistant may use them, but they are not the product interaction model by themselves.

## Architecture

### Existing layers we keep

- `assistant-core`
  - session store
  - run store
  - observation service
  - task view service
  - memory service
  - policy service
  - tool registry / tool executor
- `agent-runtime`
  - provider registry
  - runtime session / turn / event
  - approval / question / waiting states
- `agent-orchestrator`
  - runtime control APIs already used by tools

### New layer

Add a new `assistant-agent` layer:

- `dialogue-service.js`
  - top-level `/cligate` dialogue orchestration
- `react-engine.js`
  - ReAct loop
- `llm-client.js`
  - assistant model invocation
- `prompt-builder.js`
  - system prompt and summary-first context packing
- `tool-schema.js`
  - LLM-facing tool definitions
- `reflection-service.js`
  - delegation result follow-up and runtime summarization
- `response-composer.js`
  - natural-language final reply synthesis
- `stop-policy.js`
  - completed / waiting_runtime / waiting_user / failed decision

## ReAct Loop

The assistant run loop is:

1. `observe`
   - collect summary-first context from:
     - task view
     - conversation context
     - memory
     - policy
2. `reason`
   - ask the assistant model what to do next
3. `act`
   - execute structured tool calls
4. `reflect`
   - after delegation or observation, decide whether more steps are needed
5. `respond`
   - reply naturally to the user, or enter a wait state

This loop continues until one of:

- final answer ready
- waiting on runtime
- waiting on user
- failure
- max iterations reached

## Tooling Model

The assistant model uses structured tool calls, not regex parsing.

The first tool set includes:

- `get_workspace_context`
- `list_runtime_sessions`
- `get_runtime_session`
- `list_conversations`
- `get_conversation_context`
- `list_tasks`
- `get_task`
- `search_project_memory`
- `delegate_to_codex`
- `delegate_to_claude_code`
- `delegate_to_runtime`
- `reuse_or_delegate`
- `send_runtime_input`
- `resolve_runtime_approval`
- `answer_runtime_question`
- `reset_conversation_binding`
- `summarize_runtime_result`

Policy gating still happens in `assistant-core/tool-executor.js`.

## Model Invocation Strategy

Assistant-model invocation should reuse the existing multi-source stack where possible.

Preferred assistant sources:

1. ChatGPT account backend via `direct-api.sendMessage`
2. Claude account via `sendClaudeMessageWithMeta`
3. Anthropic API key
4. OpenAI / Azure OpenAI API key through existing Anthropic-to-Responses bridge

The assistant model is separate from delegated runtime providers:

- assistant model = supervisor
- Codex / Claude Code runtime = executor

## Prompting Principles

The assistant prompt must:

- state that the assistant is `CliGate Assistant`
- state that it is a supervisor agent
- tell it to speak naturally to users
- tell it not to expose internal tool details unless necessary
- tell it to prefer direct answers when no tool or runtime work is needed
- tell it to delegate only when execution is actually needed
- give it task / memory / policy summaries

The prompt should be summary-first. Do not dump full transcripts by default.

## Phase Scope

### Phase A

Deliver a true assistant LLM loop for `/cligate`:

- natural-language direct replies
- structured tool calls for read-only observation
- fallback to existing runner only when no assistant model source is available

### Phase B

Deliver runtime delegation and reflection:

- assistant can delegate to Codex / Claude Code
- assistant can continue existing runtime sessions
- assistant can summarize runtime results
- assistant can decide whether it still needs more tool calls after executor output

### Phase C

Deliver full collaboration closure:

- summary-first memory / policy context injected into the assistant loop
- assistant can use task view as its default operational read model
- assistant run lifecycle persists loop steps and waiting reasons
- async `/cligate` runs still produce a natural final result, not just internal status text

## Compatibility Plan

The redesign keeps all existing infrastructure intact.

Compatibility rules:

- ordinary non-`/cligate` messages still use the direct runtime path
- `/runtime` still exits assistant mode
- old `assistant-core/runner.js` remains as a deterministic fallback path
- existing stores and APIs remain readable by dashboard and tests

## Success Criteria

The redesign is successful when:

1. `/cligate 你是谁` produces a natural assistant answer
2. `/cligate 帮我检查登录流程` can trigger observation + delegation + summary through the assistant model loop
3. assistant replies are primarily natural-language assistant output
4. task view, memory, policy, and runtime are used as internal support planes
5. the system still supports async channel delivery and waiting states
