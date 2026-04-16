# CLI Agent Runtime 设计说明

## 1. 目标

让当前项目不只是“给 Claude Code / Codex / Gemini CLI 配代理”，而是能在对话中：

1. 启动指定 CLI agent
2. 向该 agent 发送首条任务和后续追问
3. 持续监控执行进度、工具调用、权限请求、错误和最终结果
4. 支持长时间任务、断线恢复、再次接管和继续对话
5. 在必要时由用户确认权限，确认后继续运行

这件事的本质不是“控制窗口”，而是“实现一个可编程的 CLI 会话运行时”。

## 2. 当前项目现状

### 2.1 已有能力

- `src/routes/chat-ui-route.js`
  已有 Web Chat，对话流式返回、assistant mode、待确认动作确认接口。
- `src/assistant/tool-executor.js`
  已有 `confirmToken` 风格的人工确认机制，可直接复用到 CLI 权限审批。
- `src/routes/tools-route.js`
  已有工具安装、检测、启动接口。
- `src/tool-launcher.js`
  目前只负责“打开一个新的终端窗口”，不保存进程句柄，不回收 stdout/stderr，也没有会话概念。
- `src/routes/api-routes.js`
  当前路由组织清晰，适合新增 `/api/agent-runtimes/*` 一组接口。

### 2.2 当前缺口

- 没有“CLI 会话”模型
- 没有子进程生命周期管理
- 没有 stdout/stderr 持续采集
- 没有权限请求状态机
- 没有长任务恢复和重新附着
- 没有把“聊天消息”映射为“发给外部 CLI agent 的一轮 turn”

## 3. 对参考源码的关键结论

### 3.1 Codex

`codex` 不应该以“开窗口+盯屏幕”的方式集成。

从 `D:\localagentdemo\ccopensource\codex\sdk\typescript\src\exec.ts` 可以看到：

- SDK 本质上是 `spawn(codex, ["exec", "--experimental-json", ...])`
- 通过 stdin 发送输入
- 通过 stdout 读取 JSONL 事件
- 支持 `resume <threadId>`
- 事件模型已经包含：
  - `thread.started`
  - `turn.started`
  - `item.started / updated / completed`
  - `turn.completed`
  - `turn.failed`

从 `sdk/typescript/src/items.ts` 可见，Codex 的事件已经显式暴露：

- `agent_message`
- `command_execution`
- `file_change`
- `mcp_tool_call`
- `todo_list`
- `reasoning`

这说明：

- Codex 最适合做成“结构化 runtime provider”
- 不需要窗口自动化
- 可以天然支持长任务监控、可恢复会话和继续对话

### 3.2 Claude Code

你提供的 `claude-code` 源码虽然不是官方直接发布的 SDK，但它的 headless/print 路径已经暴露出很清晰的协议层。

从 `src/main.tsx` 和 `src/cli/print.ts` 可见：

- 支持 `-p/--print`
- 支持 `--output-format stream-json`
- 支持 `--input-format stream-json`
- 支持 `--resume`
- 支持 `--permission-prompt-tool`

从 `src/cli/structuredIO.ts` 可见：

- 它内部有结构化 stdin/stdout 协议
- 权限请求通过 `control_request`
- 用户确认通过 `control_response`
- 权限请求核心 subtype 是 `can_use_tool`
- 也支持取消请求和恢复未决请求

这说明：

- Claude Code 也不应优先走“监控窗口”
- 更合理的方案是直接接它的 headless stream-json/控制协议
- 权限审批可以被我们自己的 Web Chat 接管

## 4. 总体架构建议

建议新增一层：

- `CLI Agent Runtime Layer`

位于：

- 上层：当前 Web Chat / assistant mode / dashboard
- 下层：Codex / Claude Code / Gemini CLI / 其他 CLI

### 4.1 分层

1. `AgentRuntimeRegistry`
   负责不同 CLI 的 provider 注册与能力声明

2. `AgentSessionManager`
   负责会话创建、恢复、销毁、心跳、持久化、事件分发

3. `AgentProvider`
   每个 CLI 一个 provider，例如：
   - `codex-provider`
   - `claude-code-provider`
   - `gemini-cli-provider`

4. `AgentEventBus`
   把运行事件广播给：
   - Web Chat SSE
   - Dashboard
   - 日志系统
   - 持久化存储

5. `AgentApprovalService`
   负责权限请求、用户确认、超时、拒绝、继续执行

6. `AgentTranscriptStore`
   存会话元数据、消息、事件、最终结果、错误、checkpoint

## 5. Provider 能力模型

建议统一定义 provider capability：

```js
{
  id: "codex",
  launchMode: "structured-sdk" | "structured-cli" | "pty" | "window-only",
  supportsResume: true,
  supportsStreamingEvents: true,
  supportsApprovalRequests: true,
  supportsInputInjection: true,
  supportsInterrupt: true
}
```

建议实现三类 provider：

### 5.1 Structured SDK Provider

适用于 Codex。

特征：

- 直接 `spawn`
- stdin/stdout 都是结构化协议
- provider 自己知道如何 parse event

### 5.2 Structured CLI Provider

适用于 Claude Code。

特征：

- 还是启动 CLI 进程
- 但走 `--print --input-format stream-json --output-format stream-json`
- 权限确认走 control request / response

### 5.3 PTY Provider

适用于没有官方结构化接口、但至少是终端交互式的 CLI。

例如未来的 Gemini CLI 若只有 TTY 交互而没有稳定 JSON 流，可退化为 PTY。

这里需要：

- `node-pty`
- Windows 用 ConPTY
- stdout 做行缓冲和状态识别
- stdin 注入用户消息或确认指令

### 5.4 Window-only Provider

这是最后兜底，不建议作为主路径。

原因：

- 难稳定识别完成态
- 难获取结构化权限请求
- 难恢复会话
- 无法保证再次接管

## 6. 会话模型

建议新增统一的 session 实体：

```js
{
  id,
  providerId,
  toolId,
  status, // starting | running | waiting_input | waiting_approval | completed | failed | cancelled
  title,
  cwd,
  model,
  createdAt,
  updatedAt,
  processInfo: {
    pid,
    transport: "structured-sdk" | "structured-cli" | "pty"
  },
  providerSessionId, // codex thread id / claude session id
  lastEventSeq,
  finalResult,
  error
}
```

### 6.1 事件模型

统一事件格式：

```js
{
  sessionId,
  seq,
  ts,
  type,
  payload
}
```

事件类型建议至少包括：

- `session.started`
- `session.updated`
- `message.delta`
- `message.completed`
- `tool.started`
- `tool.updated`
- `tool.completed`
- `approval.requested`
- `approval.resolved`
- `task.progress`
- `task.completed`
- `task.failed`
- `session.completed`
- `session.failed`

## 7. 权限审批设计

你们现有 `confirmToken` 机制可以直接升级为通用审批中心。

### 7.1 统一审批实体

```js
{
  approvalId,
  sessionId,
  providerId,
  status, // pending | approved | denied | expired
  kind,   // tool_permission | network_access | file_write | exec
  title,
  summary,
  rawRequest,
  createdAt,
  resolvedAt
}
```

### 7.2 Claude Code

当 provider 收到 `control_request` / `can_use_tool`：

1. 创建 approval record
2. 向前端 SSE 推送 `approval.requested`
3. 前端展示“允许 / 拒绝”
4. 用户点击后，后端调用 provider `respondApproval()`
5. provider 向 claude 进程 stdin 回写 `control_response`

### 7.3 Codex

如果是 SDK/CLI 原生 approval policy：

- 优先尝试通过配置让它进入可编程审批模式
- 如果 SDK 当前没有暴露交互式 approval event，就先用：
  - `approvalPolicy: "never"` 或可自动化策略
  - 对高风险任务限制为只读 / workspace-write

结论：

- Claude Code 可以做真正的“外部审批接管”
- Codex 第一阶段更适合做“受控自动化 + 结构化监控”

## 8. 持续对话设计

### 8.1 同一 session 内继续追问

用户在 Web Chat 中继续输入：

- 如果 provider 支持 resume/thread continuation
  - Codex：复用 thread id
  - Claude：复用 session/resume 参数
- 否则：
  - 由 provider 自己拼装 transcript 再发起新 turn

### 8.2 长任务

长任务不是一条 HTTP 请求，而是一个后台 session。

因此必须把：

- 请求响应式接口

改成：

- 创建 session
- 订阅 session 事件流
- 任意时刻再附着

建议新增：

- `POST /api/agent-runtimes/sessions`
- `GET /api/agent-runtimes/sessions`
- `GET /api/agent-runtimes/sessions/:id`
- `POST /api/agent-runtimes/sessions/:id/input`
- `POST /api/agent-runtimes/sessions/:id/approval`
- `POST /api/agent-runtimes/sessions/:id/cancel`
- `GET /api/agent-runtimes/sessions/:id/stream`

## 9. 完成态判断

不同 provider 的完成态来源不同：

### 9.1 Codex

以结构化事件为准：

- `turn.completed`
- `turn.failed`

### 9.2 Claude Code

以结构化输出为准：

- 最终 assistant 消息完成
- 当前 turn 结束
- 没有未决 `control_request`

### 9.3 PTY provider

只能走启发式判断：

- 进程退出
- 明确 prompt 回到 idle 状态
- 一定时间没有输出且出现已知完成提示

所以 PTY provider 只能作为兼容层，不适合主控路径。

## 10. 存储与恢复

建议不要只把状态保存在内存里。

新增本地存储文件，例如：

- `~/.cligate/agent-sessions.json`
- `~/.cligate/agent-events/<sessionId>.jsonl`

至少保存：

- session metadata
- providerSessionId
- 最后事件序号
- 当前审批状态
- 最终结果摘要

这样 Electron 或服务重启后，还能：

- 展示历史任务
- 查看完成结果
- 对未结束任务标记为 interrupted
- 对支持 resume 的 provider 允许重新接管

## 11. 与现有项目的衔接建议

### 11.1 不要继续扩展 `src/tool-launcher.js`

这个文件适合保留为：

- “一键打开外部工具窗口”

但不适合升级成 runtime manager。

建议新增：

- `src/agent-runtime/registry.js`
- `src/agent-runtime/session-manager.js`
- `src/agent-runtime/session-store.js`
- `src/agent-runtime/event-bus.js`
- `src/agent-runtime/approval-service.js`
- `src/agent-runtime/providers/codex-provider.js`
- `src/agent-runtime/providers/claude-code-provider.js`
- `src/routes/agent-runtimes-route.js`

### 11.2 复用 assistant confirm 机制

可直接借鉴：

- `src/assistant/tool-executor.js`
- `src/routes/chat-ui-route.js`

但要从“一次性 pending action”升级为“可持续的 session approval queue”。

### 11.3 复用现有 SSE 风格

`chat-ui-route.js` 已经有简洁 SSE 输出格式，新的 runtime stream 可以延续同样风格，前端改造成本低。

## 12. 推荐分阶段落地

### Phase 1

目标：先把 Codex 跑通成真正可编程 session。

实现：

- 新建 session manager
- 新建 codex provider
- 通过 `spawn + structured json events` 运行
- 前端能看到：
  - 流式文本
  - command execution
  - file change
  - completed / failed
- 支持继续对话和 resume thread

这是最稳的一步，成功率最高。

### Phase 2

目标：接入 Claude Code headless structured mode。

实现：

- provider 封装 `--print --input-format stream-json --output-format stream-json`
- 接管 `control_request` / `control_response`
- 把审批接入现有 Web Chat
- 支持 session resume

这是核心价值最大的阶段。

### Phase 3

目标：补 PTY 兼容层，覆盖没有结构化协议的 CLI。

实现：

- 引入 `node-pty`
- 增加 `pty-provider`
- 增加 prompt/完成态/审批提示词启发式识别

这一层用于兼容 Gemini CLI 或未来第三方 agent，不作为首选架构。

### Phase 4

目标：做 dashboard 级的任务中心。

实现：

- 会话列表
- 审批中心
- 历史 transcript
- 重新附着
- 中断/取消/继续

## 13. 关键技术决策

### 13.1 主路径必须是结构化协议，不是窗口监控

原因：

- 更稳定
- 更可恢复
- 更容易做权限确认
- 更容易做长任务

### 13.2 会话必须后台化

原因：

- 长任务不能绑死在单次 HTTP 请求上
- 需要重新附着和继续对话

### 13.3 审批必须是 runtime 的一等公民

不是临时 toast，也不是日志里的字符串。

否则 Claude Code 这类 agent 的价值无法真正接住。

## 14. 风险与注意点

### 14.1 Windows

如果走 PTY：

- 优先选 `node-pty` + ConPTY
- 不要自己拼 `cmd /c start`

### 14.2 子进程安全

需要限制：

- cwd
- env 透传范围
- 可执行路径
- provider 白名单

### 14.3 输出体积

长任务 stdout 非常大，不能只保存在内存中。

建议：

- 内存保留最近 N 条事件
- 全量事件落盘 JSONL

### 14.4 provider 差异

不要试图一开始就抽象成“完全统一协议”。

应该先统一 session 生命周期和审批模型，事件 payload 允许 provider-specific 字段存在。

## 15. 最终建议

### 立即执行的实现顺序

1. 新增 `agent-runtime` 目录和 session manager
2. 先实现 `codex-provider`
3. 跑通 session 创建、stream、继续对话、落盘
4. 再实现 `claude-code-provider`
5. 接上 approval queue 和前端交互
6. 最后再考虑 Gemini 的 PTY 兼容层

### 不建议的路线

- 不建议把“监控外部窗口”作为主方案
- 不建议继续在 `tool-launcher.js` 上堆状态
- 不建议一开始就做所有 CLI 的统一伪终端驱动

因为那会把最容易做对的 Codex/Claude 结构化接入，反而降级成最脆弱的窗口自动化。

