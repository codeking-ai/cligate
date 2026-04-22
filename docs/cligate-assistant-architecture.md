# CliGate Assistant 架构设计方案

## 1. 文档目的

本文档用于定义 CliGate Assistant 的正式架构方案，为后续开发提供统一指导。

本文档重点回答以下问题：

- 在当前 `agent-runtime`、`agent-channels`、`assistant` 基础上，如何演进到符合产品愿景的架构
- 哪些设计应参考 Codex 与 Claude Code，哪些不应照搬
- 最终系统应该如何分层
- 关键模块、领域对象、数据流与职责边界是什么
- 迁移步骤应如何拆分，才能在不破坏现有能力的前提下逐步落地

本文档与以下文档配套：

- [cligate-assistant-vision.md](D:/proxypool-hub/docs/cligate-assistant-vision.md)
- [cligate-assistant-requirements.md](D:/proxypool-hub/docs/cligate-assistant-requirements.md)

---

## 2. 背景与设计输入

当前项目已经具备以下能力：

- 多模型代理与账号路由
- `Codex` / `Claude Code` runtime provider
- session manager / approval / question / event bus
- Telegram / 飞书 / 钉钉等 channel 接入
- 会话记录、delivery、pairing、sticky session
- 一套偏轻量的 assistant/chat 能力

当前问题在于：

- assistant、channel orchestrator、runtime control 三类职责尚未完全分层
- 现有 `message-service` 同时承载 direct runtime 控制和部分上层编排语义
- 缺少一个真正独立的、面向产品形态的 `CliGate Assistant Control Plane`

本次架构设计以以下目标为前提：

1. 普通消息继续保持 direct runtime 行为稳定
2. `/cligate` 显式唤起 assistant 后，应进入真正的 assistant 协作链路
3. assistant 具备调度与运维能力，但不替代 Codex / Claude Code 的执行职责
4. assistant 能观察全局，执行时又只携带当前 session 所需上下文

---

## 3. 参考项目结论

本方案参考了以下两个本地项目：

- `D:\localagentdemo\ccopensource\codex`
- `D:\localagentdemo\ccopensource\claude-code`

## 3.1 参考 Codex 的部分

Codex 最值得借鉴的是结构化执行模型：

- `thread`
- `turn`
- `event`

其优点在于：

- 会话与执行轮次区分清晰
- 事件流是结构化协议，而不是非结构化文本
- 适合做上层观察、状态汇总、恢复、回放和控制

对 CliGate 的启发：

- runtime 层应进一步显式区分 `session` 与 `turn`
- 所有执行状态都应通过统一事件模型暴露
- assistant 不应直接读取底层 stdout 文本，而应消费结构化 observation

## 3.2 参考 Claude Code 的部分

Claude Code 最值得借鉴的是 agent 主循环和权限系统：

- `query loop`
- `tool loop`
- `permission`
- `question / elicitation`
- `session memory`

其优点在于：

- 工具调用与审批是主循环中的一等对象
- 会话态、记忆态、权限态都长期存在
- 更适合做可交互、可中断、可恢复的 agent

对 CliGate 的启发：

- assistant 应拥有独立的 run engine，而不只是一次性 request handler
- assistant 的多步执行应被建模为受控运行对象
- 审批、提问、阻塞与恢复应进入统一 control flow

## 3.3 不应照搬的部分

不应直接照搬 Codex 或 Claude Code 的以下内容：

- 单一 CLI / REPL 产品形态
- 终端 UI 主导的系统边界
- 将 agent 本体与 executor 本体耦合在一起
- 把所有控制逻辑都压进单个 query loop

原因是 CliGate 的产品形态不同：

- 多入口：Web、Telegram、飞书
- 多 conversation 并行
- Codex / Claude Code 对我们而言是 executor provider
- 我们需要的是 control-plane-first 架构，而不是 executor-first 架构

---

## 4. 核心架构原则

本方案采用以下架构原则。

### 4.1 Direct Runtime 与 Assistant 分流

系统必须明确区分两条路径：

- `Direct Runtime Path`
- `Assistant Collaboration Path`

前者强调低打扰与稳定，后者强调多步执行、调度与运维。

### 4.2 Control Plane 与 Execution Plane 分离

Assistant 不直接承担底层执行，而是通过运行控制服务驱动 executor。

### 4.3 Observation First

Assistant 的核心能力来自结构化观察，而不是直接吞完整消息全文或日志全文。

### 4.4 Memory With Scope

偏好、权限、项目知识、会话态必须按作用域分层。

### 4.5 Tool-Governed Agent

Assistant 的能力必须通过工具系统暴露，而不是把业务逻辑散落在 route 和 store 中。

### 4.6 Incremental Migration

迁移必须分阶段进行，不能推翻当前可用链路。

---

## 5. 目标架构总览

建议采用 5 层架构：

```text
Experience Plane
    ->
Routing / Mode Switch Plane
    ->
Assistant Control Plane
    ->
Runtime Execution Plane
    ->
Proxy / Model Access Plane
```

同时旁路配套两类横切层：

- `Observation Plane`
- `Memory / Policy Plane`

简化结构如下：

```text
Web / Telegram / Feishu
        |
        v
Experience Router
        |
        +--> Direct Runtime Path
        |        |
        |        v
        |   Runtime Control Service
        |        |
        |        v
        |   Runtime Session Manager
        |        |
        |        +--> Codex Provider
        |        +--> Claude Code Provider
        |
        +--> Assistant Path
                 |
                 v
           Assistant Session
                 |
                 v
             Assistant Run
                 |
        +--------+--------+
        |                 |
        v                 v
Observation Service   Assistant Tool Registry
        |                 |
        +--------+--------+
                 |
                 v
         Runtime Control Service
```

---

## 6. 分层设计

## 6.1 Experience Plane

职责：

- 承接 Web、Telegram、飞书等入口
- 规范化用户消息
- 记录 conversation 维度的上下文
- 将消息路由到 direct runtime 或 assistant

建议保留并继续演进的现有模块：

- `src/agent-channels/*`
- `src/routes/chat-ui-route.js`
- `src/routes/agent-channels-route.js`

建议新增职责：

- 显式 `mode switch`
- assistant 模式状态管理
- `/cligate` 与 `/runtime` 的入口分流

## 6.2 Routing / Mode Switch Plane

职责：

- 判断当前 conversation 处于哪种模式
- 将消息路由到：
  - direct runtime control
  - assistant session runner
- 维持 conversation 与 assistant session / runtime session 的关系

不建议继续将这个职责深埋在当前 `message-service` 中。

建议新增独立的 mode switch 服务。

## 6.3 Assistant Control Plane

这是未来的核心层。

职责：

- 持有 `CliGate Assistant` 的全局身份
- 管理每个 conversation 的 `assistant session`
- 驱动一次 `/cligate` 请求对应的 `assistant run`
- 通过工具查看状态、读取上下文、调度 executor
- 在多步执行结束后向用户输出自然语言结果

这一层不是 executor，本质上是：

- supervisor
- operator
- planner
- orchestrator

## 6.4 Runtime Execution Plane

职责：

- 维持 `Codex` / `Claude Code` 运行时 session
- 管理 turn 生命周期
- 处理 provider 层审批、提问与事件
- 输出统一事件

建议以当前 `src/agent-runtime/*` 为基础继续强化，不另起炉灶。

## 6.5 Proxy / Model Access Plane

职责：

- 保持现有代理、路由、账号池、转发逻辑
- 继续作为 Codex / Claude Code 的模型流量底座

这一层不应因 assistant 架构演进而被大改。

## 6.6 Observation Plane

职责：

- 将散落在 runtime、conversation、task、delivery、approval 各处的数据统一收敛为 assistant 可消费的结构化观察结果

Assistant 不应直接跨多个 store 拼接状态，而应统一调用 observation service。

## 6.7 Memory / Policy Plane

职责：

- 管理偏好与记忆
- 管理权限与自动批准规则
- 管理作用域隔离

---

## 7. 核心领域对象

建议将系统围绕以下对象建模。

## 7.1 Conversation

表示一个外部入口会话。

来源可能是：

- Web Chat
- Telegram conversation
- 飞书 conversation

主要职责：

- 保存入口身份
- 保存当前模式
- 关联 active runtime / assistant session

## 7.2 AssistantSession

表示某个 conversation 对应的 assistant 上下文。

职责：

- 维护当前 assistant 模式状态
- 保存最近任务摘要、上下文摘要
- 关联最近一次或当前的 assistant run
- 提供 conversation 维度记忆作用域

## 7.3 AssistantRun

表示 assistant 一次受控多步执行。

职责：

- 记录触发输入
- 记录计划与步骤
- 记录工具调用
- 记录相关 runtime session
- 输出最终摘要

建议状态：

- `queued`
- `running`
- `waiting_runtime`
- `waiting_user`
- `completed`
- `failed`
- `cancelled`

## 7.4 RuntimeSession

表示 Codex / Claude Code 的执行线程。

已有基础：

- `src/agent-runtime/models.js`
- `src/agent-runtime/session-manager.js`

后续建议进一步显式区分 session 与 turn。

## 7.5 RuntimeTurn

表示 RuntimeSession 中的一次输入驱动执行轮次。

Codex 的 `thread / turn` 模型说明这层应独立存在。

建议后续新增。

## 7.6 Task

面向用户的任务对象。

职责：

- 聚合 assistant run 与 runtime session 的结果
- 提供用户可感知的任务视图
- 支持汇总、跟踪、筛选

## 7.7 Approval

表示需要用户或策略决策的授权请求。

## 7.8 Question

表示 runtime 需要用户补充输入的问题。

## 7.9 Observation

表示 assistant 用于思考与决策的结构化可见信息。

例如：

- 当前运行会话摘要
- 失败会话摘要
- conversation 绑定状态
- 待审批队列

## 7.10 ToolCall

表示 assistant 一次工具调用记录。

---

## 8. 模块设计建议

## 8.1 保留并继续演进的现有模块

以下模块方向正确，应继续保留：

- `src/agent-runtime/*`
- `src/agent-channels/*`
- `src/agent-core/*`
- `src/agent-orchestrator/conversation-supervisor-state.js`
- `src/agent-runtime/approval-policy*.js`

## 8.2 建议收敛职责的现有模块

### `src/agent-orchestrator/message-service.js`

未来不应继续作为总编排入口。

建议收敛成：

- direct runtime 控制服务
- 显式命令处理器
- approval / question relay

不再承担完整 assistant 主循环职责。

### `src/assistant/*`

当前更偏 Web Chat 辅助逻辑。

建议未来将其与真正的 assistant control plane 区分开，避免混淆。

## 8.3 建议新增的模块组

建议新增目录：

```text
src/
  assistant-core/
    session-store.js
    run-store.js
    runner.js
    planner.js
    tool-registry.js
    tool-executor.js
    observation-service.js
    memory-service.js
    policy-service.js
    mode-service.js
    models.js
```

### `session-store.js`

职责：

- 维护 assistant session
- conversation -> assistant session 映射

### `run-store.js`

职责：

- 维护 assistant run 生命周期与运行记录

### `runner.js`

职责：

- 驱动一次 assistant run 的多步执行
- 控制步数预算、时间预算、状态切换

### `planner.js`

职责：

- 根据用户输入与 observation 形成结构化执行计划
- 决定是否读取更多上下文
- 决定是否调用 runtime

### `tool-registry.js`

职责：

- 注册 assistant 可用工具
- 工具分组：
  - observation tools
  - runtime control tools
  - delegation tools
  - project read-only tools

### `tool-executor.js`

职责：

- 实际执行 tool call
- 记录 tool result

### `observation-service.js`

职责：

- 聚合 runtime、conversation、task、delivery、approval 数据
- 输出 summary-first 的结构化观察结果

### `memory-service.js`

职责：

- 统一 global / workspace / conversation / runtime-session 四层记忆

### `policy-service.js`

职责：

- 管理自动批准、边界校验、风险分级

### `mode-service.js`

职责：

- 管理 direct runtime 与 assistant mode 切换

---

## 9. 数据流设计

## 9.1 Direct Runtime Path

适用于普通消息。

```text
Inbound Message
  -> Conversation Resolve
  -> Mode Check
  -> Direct Runtime Control
  -> Runtime Session Manager
  -> Provider
  -> Event Bus
  -> Channel/Web Reply
```

行为要求：

- 不做模糊 assistant 拦截
- 有 active runtime 时默认继续
- 无 active runtime 时按默认 provider 启动

## 9.2 Assistant Path

适用于 `/cligate`。

```text
Inbound /cligate
  -> Conversation Resolve
  -> Assistant Session Resolve
  -> Assistant Run Create
  -> Observation Summary
  -> Planner
  -> Tool Calls
  -> Runtime Control (when needed)
  -> Wait / Observe / Summarize
  -> Final Reply
```

行为要求：

- assistant 可先发“正在执行”
- 后台进行有限多步操作
- 最终返回自然语言结果

## 9.3 Approval / Question Path

```text
Runtime Event
  -> Approval / Question Normalize
  -> Policy Check
      -> auto-resolve if within allowed boundary
      -> otherwise ask user
  -> User reply
  -> Runtime response
```

## 9.4 Observation Path

```text
Runtime Sessions
Conversation Store
Task Store
Delivery Store
Approval Store
    ->
Observation Service
    ->
Assistant Summary / Drill-down Tool
```

---

## 10. 工具设计原则

第一阶段 assistant 工具清单已经在需求文档中定义。

本架构文档强调实现原则：

### 10.1 先结构化观测，后自由扩展

优先实现：

- `list_runtime_sessions`
- `get_runtime_session`
- `list_conversations`
- `get_conversation_context`
- `get_workspace_context`

### 10.2 Runtime 控制工具统一收口

所有启动、继续、取消、批准、回答等动作都应通过统一 runtime control service 进入，避免 assistant 直接操作 provider。

### 10.3 Assistant 不直接拥有 executor 权限

第一阶段 assistant 原则上不直接执行：

- shell
- 文件写入
- 浏览器控制

这些动作由 Codex / Claude Code 落地。

### 10.4 高风险副作用应经过 policy service

assistant 可以更自主，但不能绕过边界检查。

---

## 11. 记忆与权限架构

## 11.1 记忆作用域

统一采用 4 层：

1. `global user`
2. `workspace / project`
3. `conversation`
4. `runtime session`

## 11.2 权限原则

沿用当前需求共识：

- 读操作自动
- 调度操作自动
- 副作用操作分级放开
- assistant 可在已授权边界内自主决策
- 但不能静默扩大权限边界

## 11.3 自动批准机制

建议通过 `policy-service` 统一管理：

- scope
- risk level
- provider
- tool name
- path pattern
- command prefix

---

## 12. 状态与存储建议

## 12.1 需要长期存储的对象

- conversation
- assistant session
- assistant run
- runtime session
- runtime event
- task
- approval policy
- preference / memory

## 12.2 建议保留 summary-first 存储

对于 transcript / event / delivery，建议：

- 原始记录仍可存
- 但额外维护 summary / index / pointer

原因：

- assistant 默认只消费摘要
- 需要时再按 conversation / runtime session 下钻

---

## 13. 迁移步骤

迁移必须分阶段进行。

## Phase 0：保持现状可用

目标：

- 维持 direct runtime 当前行为
- 维持 channel 通路可用
- 不破坏现有 session / approval / question 机制

当前已完成的收口：

- 普通消息默认不再被自然语言 supervisor 误拦截

## Phase 1：收敛 direct runtime control

目标：

- 将 `message-service` 收敛成 direct runtime control service
- 保留显式命令、approval、question、continue/start 逻辑
- 不在该层继续新增 assistant 复杂能力

建议动作：

1. 将现有 direct runtime 路由逻辑固定下来
2. 抽出 mode switch 边界
3. 为 `/cligate` 预留单独分流入口

## Phase 2：引入 Assistant Session 与 Assistant Run

目标：

- 建立 assistant 的独立运行对象

建议动作：

1. 新增 `assistant-core/models.js`
2. 新增 `assistant session store`
3. 新增 `assistant run store`
4. 新增 `mode-service`
5. conversation 上新增 assistant mode 状态

交付效果：

- `/cligate`
- `/cligate <request>`
- `/runtime`

三种行为有独立存储与状态流转。

## Phase 3：引入 Observation Service

目标：

- 让 assistant 可以全局观测而不直接耦合多个 store

建议动作：

1. 聚合 runtime session summary
2. 聚合 conversation summary
3. 聚合 blocked / failed / waiting queues
4. 提供摘要与下钻 API

交付效果：

- assistant 首先获取结构化 summary
- 需要时再下钻 transcript / event

## Phase 4：引入 Assistant Tool Registry 与 Runner

目标：

- 让 `/cligate` 从一次性 handler 演进为受控多步 agent

建议动作：

1. 新增 `tool-registry`
2. 新增 `tool-executor`
3. 新增 `runner`
4. 实现有限步数、时间预算、状态管理

交付效果：

- assistant 先回复“正在执行”
- 后台多步运行
- 最后汇总结果

## Phase 5：引入 Memory / Policy Service

目标：

- 统一偏好、记忆与自动批准边界

建议动作：

1. 将现有 preference store 与 approval policy store 纳入统一作用域模型
2. 引入 workspace scope
3. 引入 assistant 自动批准边界判定

交付效果：

- assistant 能在已授权边界内自主推进
- 不跨边界失控

## Phase 6：显式化 Runtime Turn

目标：

- 让 runtime 层更接近 Codex 风格的 `session / turn / event` 模型

建议动作：

1. 新增 runtime turn 对象
2. session 下管理 turn 列表
3. observation 中引入 turn summary

交付效果：

- 更好的恢复、追踪、统计与 assistant 汇总能力

---

## 14. 推荐落地顺序

从性价比和风险控制角度，推荐顺序如下：

1. 收敛 direct runtime control
2. 新增 assistant mode / assistant session / assistant run
3. 新增 observation service
4. 新增 assistant tool registry
5. 新增 assistant runner
6. 新增 unified memory / policy service
7. 最后再显式化 runtime turn

原因：

- 先把 direct runtime 路径稳定住
- 再建立 assistant 的产品边界
- 再增强其观察与多步执行能力
- 最后才对 runtime 内部模型做更深层升级

---

## 15. 风险与注意事项

## 15.1 最大风险：重新混淆 direct runtime 与 assistant

必须避免：

- 再次让普通消息进入自然语言模糊拦截
- 将 assistant 与 runtime control 写回一个单体模块

## 15.2 最大复杂度来源：观察与记忆直接耦合底层 store

必须避免：

- assistant 到处读不同 store 拼装状态

正确做法：

- 通过 observation service 统一读取

## 15.3 最大产品风险：assistant 过早直接持有危险执行权

第一阶段不建议让 assistant 直接拥有：

- shell
- 写文件
- 浏览器自动化

应继续借力 Codex / Claude Code 落地。

---

## 16. 最终结论

符合 CliGate 当前产品愿景与需求的正式架构方案应为：

**以 assistant control plane 为核心、以 runtime execution plane 为执行底座、以 observation plane 和 memory/policy plane 为横切支撑、以 Web / Telegram / 飞书等入口作为 experience plane 的多层系统。**

其中：

- Codex 提供我们最值得借鉴的 `thread / turn / event` 执行模型
- Claude Code 提供我们最值得借鉴的 `tool / permission / interactive loop` 控制思想
- CliGate 不应复制任一项目的终端产品形态，而应形成属于自己的 `control-plane-first` 架构

在这个架构下：

- 普通消息继续稳定地进入 direct runtime
- `/cligate` 显式进入 assistant 协作模式
- assistant 具备调度、运维、阻塞处理与结果汇总能力
- executor 继续承担代码与工具落地执行
- 后续能力扩展有明确边界与稳定演进路径
