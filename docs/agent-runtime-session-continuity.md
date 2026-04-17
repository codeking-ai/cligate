# Agent Runtime Session Continuity Design

## 1. Goal

为 CliGate 的中间智能体层补齐“会话连续性”语义：

- 同一个 Web chat 窗口默认持续绑定同一个 runtime session
- 同一个 Telegram / 飞书 conversation 默认持续绑定同一个 runtime session
- `completed` / `failed` 表示一轮任务结束，不表示会话解绑
- 只有用户显式要求，或者运行参数发生不兼容变化时，才切到新的 runtime session

这套设计的目标是让产品行为更接近 Claude Code / Codex / OpenClaw 的“持续线程”体验，而不是把每条消息都当成独立的一次性任务。

## 2. Non-goals

本设计不做以下事情：

- 不复刻 Codex / Claude Code CLI 全部界面
- 不把 `/v1/*`、`/backend-api/*` 代理链路改造成 runtime 编排链路
- 不让 CliGate 代理层承担 session manager 的职责
- 不把 channel 接入逻辑耦合进现有模型请求转发逻辑

## 3. Core Principle

要明确区分三层对象：

1. `chat conversation`
   Web 页面中的一个聊天窗口，或手机 channel 上的一个外部会话。
2. `runtime session`
   Codex / Claude Code 的持续工作线程，可跨多轮输入继续执行。
3. `turn`
   runtime session 内的一次具体执行轮次。

关键原则：

- conversation 是长期容器
- runtime session 是 conversation 当前挂接的工作线程
- turn 是 runtime session 内的一轮执行

因此：

- `worker.completed` 仅表示当前 turn 完成
- `worker.failed` 仅表示当前 turn 失败
- conversation 不应在 `completed` / `failed` 后自动丢失 `activeRuntimeSessionId`

## 4. Desired UX

### 4.1 Web chat

同一个聊天窗口里：

- 首次发送 runtime 消息时创建 session
- 后续追问默认继续同一个 session
- UI 明确显示当前已绑定的 session id、provider、status
- 用户可显式点击：
  - `New Session`
  - `Detach`

其中：

- `New Session`：保留当前聊天窗口与历史消息，但清空当前 runtime 绑定；下一条消息启动新的 runtime session
- `Detach`：仅解除当前 runtime 绑定，不删除聊天记录

如果用户在已绑定 session 的情况下修改了关键运行参数，例如：

- provider
- model

则视为“参数漂移”，下一次发送消息时自动切换到新 session，并在聊天记录中插入一条本地状态消息，明确说明原因。

### 4.2 Mobile channels

同一个 Telegram / 飞书 conversation：

- 第一次任务创建 runtime session
- 任务完成后，conversation 仍然绑定该 session
- 用户后续消息默认继续这个 session
- 用户可通过命令显式切换：
  - `/new`
  - `/new <task>`
  - `/new codex <task>`
  - `/new claude <task>`

语义：

- `/new`：解绑当前 runtime session，等待下一条消息再启动新任务
- `/new <task>`：立即启动一个新的 runtime session，并替换当前绑定

## 5. Session Selection Rules

默认复用当前绑定 session。

只有以下情况需要新建 session：

1. 当前 conversation 没有绑定 session
2. 用户显式执行 `/new` 或 UI 的 `New Session`
3. Web chat 中用户修改了关键运行参数，导致当前绑定 session 与最新配置不兼容

以下情况不自动新建 session：

- 当前 turn 已 `completed`
- 当前 turn `failed`
- 当前 turn 曾经触发审批或提问，但已处理完

## 6. State Machine

conversation 与 runtime session 的关系状态：

- `unbound`
  当前 conversation 没有挂接 runtime session
- `bound/idle`
  已挂接 session，当前 turn 已完成，可继续追问
- `bound/running`
  session 正在运行
- `bound/waiting_user`
  session 正等待用户回答问题
- `bound/waiting_approval`
  session 正等待审批

状态转换：

- `unbound -> bound/running`
  创建新 runtime session
- `bound/running -> bound/idle`
  turn completed
- `bound/running -> bound/idle`
  turn failed，但 conversation 仍绑定原 session
- `bound/* -> unbound`
  用户显式 detach / reset
- `bound/* -> bound/running(new session)`
  用户显式 new session，或参数漂移导致强制新建

## 7. Engineering Decisions

### 7.1 Channel sticky binding

`src/agent-channels/outbound-dispatcher.js` 不再在 `COMPLETED` / `FAILED` 时调用：

- `conversationStore.clearActiveRuntimeSession(...)`

改为只清理：

- `lastPendingApprovalId`
- `lastPendingQuestionId`

这样 follow-up 消息仍会被路由到原 session。

### 7.2 Explicit reset command

`src/agent-orchestrator/message-service.js` 增加 `/new` 语义：

- `/new`
- `/new <task>`
- `/new codex <task>`
- `/new claude <task>`
- `/detach`

由 router 决定是否：

- 清空当前 conversation binding
- 启动并绑定新的 runtime session

### 7.3 Web chat local binding controls

前端聊天状态增加“当前绑定 session 元信息”：

- `runtimeSessionId`
- `attachedRuntimeProvider`
- `attachedRuntimeModel`

目的：

- 区分“当前 UI 选择的 provider/model”
- 与“已经挂接运行中的 provider/model”

这样才能判断参数是否漂移。

### 7.4 Compatibility boundary

该设计不改现有代理平面：

- `/v1/messages`
- `/v1/chat/completions`
- `/backend-api/codex/*`
- `/responses`

这些仍然用于模型请求转发与 CLI 协议兼容。

新的连续会话逻辑只存在于：

- `agent-runtime/*`
- `agent-orchestrator/*`
- `agent-channels/*`
- Web chat 本地状态管理

因此不会影响现有代理功能的正确性和兼容性。

## 8. Operational Notes

### 8.1 Why this does not break proxy behavior

CliGate 代理层和中间智能体层是并列关系，不是替换关系：

- 代理层负责请求转发
- 智能体层负责启动 CLI、跟踪 session、处理审批/提问、把结果回传给用户

即使 Codex CLI 本身仍把模型请求打到 CliGate 代理，runtime session sticky 也只是上层 orchestration 状态，不会改变底层转发协议。

### 8.2 Recovery

服务重启后：

- runtime session metadata 仍从 session store 恢复
- conversation 仍保留 `activeRuntimeSessionId`
- 若 session 先前处于 `starting/running`，恢复时标为 `failed/interrupted`
- conversation 仍可以继续保留绑定，用户后续可追问或显式 `/new`

## 9. Test Focus

本方案至少需要覆盖：

1. channel conversation 在 `completed` 后不解绑
2. 后续消息能继续同一个 runtime session
3. `/new` 能显式解绑并新建 session
4. Web chat 在参数漂移时自动切到新 session
5. 现有 runtime / channel 通路不回归

## 10. Summary

最终语义应当是：

- conversation 是连续的
- runtime session 默认是 sticky 的
- turn 是阶段性的
- 完成一轮任务不等于结束整条线程
- 新 session 必须是显式行为，或由明确的不兼容参数变化触发

这才符合 CliGate 作为“中间智能体层”的定位。
