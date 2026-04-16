# CliGate 中间智能体层设计方案

## 1. 文档目的

本文档用于明确 CliGate 下一阶段要实现的能力：

- 在现有代理能力之上增加一层“中间智能体层”
- 由 CliGate 自己的 Chat 作为统一入口
- 在需要时自动启动 `Codex` 或 `Claude Code`
- 持续监控后台任务
- 将下游 agent 的进度、问题、权限确认桥接回前端聊天窗口
- 在不破坏现有代理功能的前提下完成集成

本文档强调两个原则：

1. **不复现 Codex / Claude Code 的完整 CLI**
2. **不替换现有代理层，只在其上增加编排层**

---

## 2. 需求定义

### 2.1 产品目标

用户在 CliGate 自己的对话窗口里发出请求，例如：

- “启动 claude code，帮我分析这个仓库”
- “让 codex 修复这个报错”
- “继续刚才的 codex 任务，优先最小改动”

CliGate 需要表现为一个“上层智能体”：

- 向上与用户对话
- 向下调度 Codex / Claude Code
- 在执行期间持续回传状态
- 当下游 agent 需要提问或权限确认时，把问题带回用户
- 用户回答后继续驱动下游 agent
- 任务完成后总结结果并提醒用户

### 2.2 明确不做的事情

以下内容不属于本阶段目标：

- 不做 Codex CLI 的完整 Web 版复刻
- 不做 Claude Code TUI 的完整浏览器复刻
- 不对接 Codex / Claude 的全部官方接口
- 不构造一个“通用终端替代品”
- 不做 Gemini 集成

本阶段只做：

- `Codex`
- `Claude Code`
- 启动
- 监控
- 继续对话
- 审批/提问桥接
- 完成通知

---

## 3. 核心定位

### 3.1 CliGate 的新角色

CliGate 将分成两层能力：

#### A. 现有 Proxy Core

负责：

- `Codex` 请求转发
- `Claude Code` 请求转发
- 模型路由
- API key / 账户池
- 请求日志
- 用量统计

#### B. 新增 Orchestrator Layer

负责：

- 理解用户在 Chat 中的任务意图
- 决定是否调用 `Codex` 或 `Claude Code`
- 启动 worker session
- 监听 worker 事件
- 将 worker 的问题、审批、结果桥接回前端

### 3.2 正确的系统关系

新增中间智能体后，链路应为：

```text
用户
  -> CliGate Chat
    -> CliGate Orchestrator
      -> 启动 Codex / Claude Code 本地进程
        -> Codex / Claude Code 继续调用 CliGate Proxy
          -> CliGate Proxy 再转发到上游模型
```

也就是说：

- **编排由 Orchestrator 管**
- **模型流量仍由现有 Proxy Core 管**

这两层是叠加关系，不是替换关系。

---

## 4. 设计边界

### 4.1 控制平面与数据平面分离

为了避免影响现有代理，必须做明确分层：

#### 控制平面

新增中间智能体层，处理：

- worker 启动
- session 生命周期
- 审批
- 用户问题回复
- 进度通知

#### 数据平面

保留现有代理层，继续处理：

- `/v1/messages`
- `/v1/chat/completions`
- `/v1/responses`
- `/backend-api/codex/responses`

原则：

- **不要把 worker 生命周期状态写进现有 proxy route**
- **不要把任务完成态建立在代理 HTTP 请求结束之上**
- **不要让新编排逻辑污染现有 provider 路由**

---

## 5. 借鉴 Codex 和 Claude Code 的优秀设计

### 5.1 借鉴 Codex

Codex 的优秀点主要是“结构化执行事件模型”。

建议复用这些思想：

- thread / turn 模型
- 结构化 JSON 事件流
- item 粒度的进度暴露
- resume thread 能力

适合落到 CliGate 的抽象：

- `worker_session`
- `worker_turn`
- `worker_event`

### 5.2 借鉴 Claude Code

Claude Code 的优秀点主要是“交互控制和审批模型”。

建议复用这些思想：

- 权限确认是一等事件
- headless 模式优于窗口监控
- `control_request / control_response`
- 明确的 waiting 状态
- session 恢复

适合落到 CliGate 的抽象：

- `approval_request`
- `question_request`
- `requires_user_action`
- `resume_session`

### 5.3 不照搬的部分

以下不建议照搬：

- 完整命令系统
- 完整终端 UI
- 快捷键体系
- slash command 完整支持
- 全量 CLI 配置镜像

CliGate 只吸收“架构思想”，不复刻“终端产品形态”。

---

## 6. 整体架构

建议新增如下模块：

```text
src/
  agent-runtime/
    orchestrator.js
    registry.js
    session-manager.js
    session-store.js
    event-bus.js
    approval-service.js
    models.js
    providers/
      codex-provider.js
      claude-code-provider.js
  routes/
    agent-runtimes-route.js
```

### 6.1 模块职责

#### `orchestrator.js`

负责：

- 解析用户当前意图
- 判断调用哪个 worker
- 判断是新建 session 还是继续已有 session
- 把 provider 事件翻译成上层 chat 可理解的消息

#### `registry.js`

负责：

- 注册 provider
- 声明 provider capability
- 统一 lookup

#### `session-manager.js`

负责：

- 创建/恢复/销毁 worker session
- 管理子进程生命周期
- 跟踪状态
- 协调 event bus 和 session store

#### `session-store.js`

负责：

- 落盘 session metadata
- 落盘事件流
- 断线恢复

#### `event-bus.js`

负责：

- 对外发布统一 worker 事件
- 提供 SSE 订阅
- 支持前端重连

#### `approval-service.js`

负责：

- 创建审批请求
- 管理 pending/approved/denied/expired
- 把用户决策路由回 provider

#### `codex-provider.js`

负责：

- 启动 Codex
- 向 stdin 发送 input
- 解析 JSONL event
- 把事件映射为统一 worker event

#### `claude-code-provider.js`

负责：

- 启动 Claude Code headless 模式
- 解析结构化 stream-json 输出
- 处理 `control_request`
- 接受 `control_response`

---

## 7. Session 模型

建议拆成两层会话。

### 7.1 用户会话

用户和 CliGate 主智能体的会话。

```js
{
  id,
  title,
  messages: [],
  activeWorkerSessionId: null
}
```

### 7.2 Worker 会话

下游 Codex / Claude Code 的执行会话。

```js
{
  id,
  provider: "codex" | "claude-code",
  status: "starting" | "running" | "waiting_user" | "waiting_approval" | "completed" | "failed" | "cancelled",
  cwd,
  model,
  createdAt,
  updatedAt,
  pid,
  providerSessionId,
  currentTurnId,
  title,
  summary,
  error,
  metadata: {}
}
```

### 7.3 第一版约束

为降低复杂度，第一版建议：

- 每个用户会话同时只允许一个 active worker
- 不做多 worker 并行交互
- 不做复杂任务树

这样足够支撑主要场景。

---

## 8. 统一事件协议

前端不直接消费 Codex / Claude 原生事件，必须由后端统一翻译。

建议统一格式：

```js
{
  sessionId,
  seq,
  ts,
  type,
  payload
}
```

### 8.1 事件类型

建议统一为：

- `worker.started`
- `worker.progress`
- `worker.message`
- `worker.command`
- `worker.file_change`
- `worker.question`
- `worker.approval_request`
- `worker.approval_resolved`
- `worker.completed`
- `worker.failed`

### 8.2 前端展示原则

前端只展示三类信息：

#### A. Orchestrator 消息

CliGate 自己说的话。

例如：

- “我已启动 Claude Code 处理这个任务。”
- “它正在分析代码结构。”

#### B. Worker 消息

来自下游 agent 的关键输出。

例如：

- “Scanning repository...”
- “Found 8 related files.”

#### C. Action 卡片

用于用户参与。

例如：

- 审批卡片
- 回答问题卡片

这样能保持“中间智能体”的产品定位，而不是做成“终端镜像”。

---

## 9. Provider 设计

## 9.1 Codex Provider

### 启动方式

优先采用结构化事件流模式：

- `spawn codex exec --experimental-json`
- stdin 输入 prompt
- stdout 读取 JSONL event
- 保存 `thread_id`

### 核心能力

- `startSession()`
- `sendInput()`
- `resumeSession()`
- `cancelSession()`
- `subscribeEvents()`

### 事件映射

示例：

- `thread.started` -> `worker.started`
- `item.agent_message` -> `worker.message`
- `item.command_execution` -> `worker.command`
- `item.file_change` -> `worker.file_change`
- `item.todo_list` -> `worker.progress`
- `turn.completed` -> `worker.completed`
- `turn.failed` -> `worker.failed`

### 第一阶段策略

Codex 第一阶段重点做：

- 结构化监控
- 继续对话
- 完成态识别

对“审批桥接”不强依赖，优先采用受控自动策略。

---

## 9.2 Claude Code Provider

### 启动方式

优先采用 headless structured 模式：

- `--print`
- `--input-format stream-json`
- `--output-format stream-json`

### 核心能力

- `startSession()`
- `sendInput()`
- `resumeSession()`
- `respondApproval()`
- `respondQuestion()`
- `cancelSession()`

### 关键价值

Claude Code 最值得集成的是：

- 权限请求
- 问题反问
- 明确等待状态

### 事件映射

- 普通文本 -> `worker.message`
- 进度变化 -> `worker.progress`
- `control_request(can_use_tool)` -> `worker.approval_request`
- 其他待回答输入 -> `worker.question`
- 当前 turn 完成 -> `worker.completed`

---

## 10. 审批与提问桥接

审批和问题输入不能作为普通文本处理，必须是 session 的一等状态。

### 10.1 审批实体

```js
{
  approvalId,
  sessionId,
  provider,
  status: "pending" | "approved" | "denied" | "expired",
  kind,
  title,
  summary,
  rawRequest,
  createdAt,
  resolvedAt
}
```

### 10.2 问题实体

```js
{
  questionId,
  sessionId,
  provider,
  status: "pending" | "answered" | "expired",
  text,
  options: [],
  createdAt,
  answeredAt
}
```

### 10.3 前端交互流程

#### 审批

1. worker 发出权限请求
2. provider 映射成 `worker.approval_request`
3. orchestrator 创建 approval record
4. 前端显示审批卡片
5. 用户点击允许/拒绝
6. 后端把决策写回 provider
7. worker 继续运行

#### 问题回答

1. worker 发出提问
2. provider 映射成 `worker.question`
3. 前端显示问题卡片或输入框
4. 用户输入答案
5. 后端把答案送回 provider
6. worker 继续运行

### 10.4 与现有实现的关系

现有：

- `src/assistant/tool-executor.js`
- `src/routes/chat-ui-route.js`

里的 `confirmToken` 机制可复用思路，但必须升级为：

- **session 级审批队列**

不能继续停留在“一次性页面操作确认”。

---

## 11. 持续对话与长任务

### 11.1 持续对话

用户可以在 worker 运行过程中继续发消息，例如：

- “继续”
- “优先最小改动”
- “不要改测试”

系统逻辑：

- 如果当前有 active worker 且可继续
  - 这条消息默认发给该 worker
- 如果没有 active worker
  - 由 orchestrator 决定是否新建 worker

### 11.2 长任务

长任务必须是后台 session，而不是一个长 HTTP 请求。

因此需要：

- session manager 后台持有状态
- 前端通过 SSE 订阅事件
- 服务重启后可恢复历史记录

### 11.3 完成态

完成态不能只看代理请求是否结束。

必须以 worker 自己的结构化事件为准：

#### Codex

- `turn.completed`
- `turn.failed`

#### Claude Code

- 当前 turn 结束
- 没有 pending control request
- 输出流结束

---

## 12. 持久化与恢复

建议第一版使用轻量本地文件存储。

### 12.1 存储文件

- `~/.cligate/agent-sessions.json`
- `~/.cligate/agent-events/<sessionId>.jsonl`

### 12.2 保存内容

- session metadata
- provider session id
- 当前状态
- 审批状态
- 最近关键事件
- 最终摘要

### 12.3 恢复目标

服务或 Electron 重启后：

- 能展示历史 worker
- 能看到已完成结果
- 对未完成 session 标记 `interrupted`
- 对支持 resume 的 provider 尝试重新附着

---

## 13. 与现有代理的关系

这是本设计最关键的约束。

### 13.1 现有代理必须继续工作

中间智能体层上线后，以下能力应保持不变：

- 现有 `/v1/messages` 转发
- 现有 `/backend-api/codex/responses` 转发
- 现有模型路由
- 现有账户池 / key 池
- 现有日志与用量统计

### 13.2 正确做法

让 Orchestrator 启动的 Codex / Claude Code 继续走现有代理：

- `Codex -> CliGate Proxy -> 上游模型`
- `Claude Code -> CliGate Proxy -> 上游模型`

同时：

- Orchestrator 单独监听本地 worker 事件

结论：

- **代理继续负责模型流量**
- **Orchestrator 负责任务控制与用户桥接**

### 13.3 错误做法

以下实现方式会破坏现有系统，应明确禁止：

#### 禁止 1

把 worker 生命周期状态塞进现有 proxy route。

例如直接大改：

- `src/routes/codex-route.js`
- `src/routes/messages-route.js`

使其既处理代理又处理 session。

#### 禁止 2

把代理日志当作 worker 任务状态真相来源。

原因：

- 代理知道请求发了什么
- 但不知道 worker 是否真的完成任务
- 更不知道 worker 是否在等用户

#### 禁止 3

让 CliGate 自己模拟 Codex / Claude 的全部内部运行逻辑。

这会把项目带到“复刻 CLI”方向，违背本阶段目标。

---

## 14. 兼容性与隔离策略

### 14.1 路由隔离

新增 orchestrator 路由，不改现有代理路由语义。

建议新增：

- `POST /api/agent-runtimes/sessions`
- `GET /api/agent-runtimes/sessions`
- `GET /api/agent-runtimes/sessions/:id`
- `GET /api/agent-runtimes/sessions/:id/stream`
- `POST /api/agent-runtimes/sessions/:id/input`
- `POST /api/agent-runtimes/sessions/:id/approval`
- `POST /api/agent-runtimes/sessions/:id/question`
- `POST /api/agent-runtimes/sessions/:id/cancel`

### 14.2 模块隔离

以下文件默认不动或只做极小接线改动：

- `src/routes/codex-route.js`
- `src/routes/messages-route.js`
- `src/routes/responses-route.js`
- `src/routes/chat-route.js`
- `src/tool-launcher.js`

核心新增都放在：

- `src/agent-runtime/*`

### 14.3 标识隔离

建议对 orchestrator 启动的 worker 增加单独标识，例如：

- `appId = cligate-orchestrator-codex`
- `appId = cligate-orchestrator-claude-code`

作用：

- 日志区分
- 路由区分
- 用量统计区分
- 避免和外部手动接入的 Codex / Claude Code 混淆

---

## 15. 技术选型建议

### 15.1 本阶段必须使用

- `child_process.spawn`
- SSE
- 本地 JSON / JSONL 持久化

### 15.2 本阶段不建议引入

- `node-pty`
- 窗口自动化
- 数据库
- WebSocket 重写整套前端事件系统

原因：

- `Codex` 和 `Claude Code` 都优先走结构化模式
- 先把主链路做对
- 不引入 PTY 复杂度

### 15.3 后续可选

如果未来加入缺乏结构化协议的 CLI，再考虑：

- `node-pty`
- ConPTY
- prompt/完成态启发式识别

但这不属于本阶段。

---

## 16. 推荐实施顺序

### Phase 1

先做 `Codex`

目标：

- 后台启动
- 结构化事件流
- 前端显示进度和结果
- 支持继续对话
- 支持 resume

原因：

- 协议最清晰
- 风险最低
- 最适合作为 runtime 基线

### Phase 2

再做 `Claude Code`

目标：

- 后台启动
- 结构化输出
- 审批桥接
- 问题桥接
- 继续对话

原因：

- 这是中间智能体层最有产品价值的一步

### Phase 3

完善体验

目标：

- 历史任务列表
- 断线恢复
- 更好的摘要
- 更清晰的审批中心

---

## 17. 开发注意事项

### 17.1 不影响原有代理

落地时必须遵守：

- 现有代理路由行为不变
- 不改现有 provider 语义
- 不把 orchestrator 状态写进代理核心逻辑

### 17.2 不把 worker stdout 当作唯一真相

优先级：

1. provider 结构化事件
2. provider 状态机
3. stdout 文本仅作为展示补充

### 17.3 不让编排器递归调用自己

需要明确区分：

- 普通外部客户端请求
- orchestrator 内部 worker 产生的请求

避免自调用混乱。

### 17.4 不做过度抽象

第一版不要追求“完全统一 provider 协议”。

应先统一：

- 生命周期
- 审批模型
- 前端事件模型

provider-specific payload 允许保留。

---

## 18. 结论

本方案的本质不是“在网页里重做一个 Codex 或 Claude Code”，而是：

- **以 CliGate Chat 为统一入口**
- **以现有 Proxy Core 为底层模型流量层**
- **新增 Orchestrator Layer 作为中间智能体层**

最终形态是：

- 用户只和 CliGate 对话
- CliGate 视需要调度 Codex 或 Claude Code
- 下游 agent 的关键交互被桥接回用户
- 所有模型请求仍然通过现有代理
- 原有代理功能保持稳定可用

这也是当前目标下最稳、最轻、最不容易破坏现有系统的一条实现路径。

