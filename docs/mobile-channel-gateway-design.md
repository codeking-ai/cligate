# CliGate 移动渠道接入设计

## 1. 目标

在当前网页 Chat 入口之外，为 CliGate 增加可从手机端驱动的消息渠道层，让用户可以通过 Telegram、飞书等 channel 向中间智能体发送指令，再由中间智能体调度 Codex / Claude Code 执行任务，并将执行进度、审批请求、提问和最终结果回传到对应 channel。

当前版本范围明确限定为：

- `Telegram`
- `飞书`

其他 channel 仅在架构层预留扩展能力，本阶段不实现。

本设计遵循三个边界：

1. 不复刻 Codex / Claude Code 的完整 CLI/TUI。
2. 不改造现有代理核心的数据转发链路。
3. 不把 channel 逻辑耦合进浏览器页面状态。

## 2. 当前现状与可复用点

当前仓库已经具备以下能力：

- `src/agent-runtime/*`
  已有 Codex / Claude Code 的运行时编排能力，支持创建 session、发送输入、持续事件流、审批、提问、取消、历史恢复。
- `src/routes/agent-runtimes-route.js`
  已有标准化 HTTP/SSE 接口，适合前端与后续 channel 侧复用。
- `src/routes/chat-ui-route.js`
  现有页面聊天入口，可以继续保留为 Web channel。
- `src/assistant/tool-executor.js`
  已有待确认动作的交互范式，可以借鉴到移动端审批桥接。

这意味着移动端接入不需要改写 Codex / Claude Code provider，而应新增一层“消息渠道网关”。

## 3. 正确定位

### 3.1 系统角色

CliGate 未来应有三层：

1. `Proxy Core`
   继续负责模型请求转发、鉴权、账户池、模型路由。
2. `Agent Runtime`
   继续负责启动 Codex / Claude Code、事件采集、审批状态机、会话生命周期。
3. `Channel Gateway`
   新增，负责把 Telegram / 飞书等外部消息转换为统一的用户输入，再把运行时事件格式化后发回不同 channel。

### 3.2 链路

```text
手机端用户
  -> Telegram / 飞书
    -> CliGate Channel Gateway
      -> CliGate Orchestrator / Agent Runtime
        -> Codex / Claude Code
          -> CliGate Proxy Core
            -> 上游模型
```

这个链路里：

- 手机 channel 只负责“收消息/发消息”
- 编排仍然由 `agent-runtime` 负责
- 模型请求仍然由现有 proxy 负责

因此不会把当前代理功能替换掉。

## 4. 架构设计

建议新增模块：

```text
src/
  agent-channels/
    registry.js
    router.js
    conversation-store.js
    delivery-store.js
    formatters.js
    providers/
      telegram-provider.js
      feishu-provider.js
  routes/
    agent-channels-route.js
```

### 4.1 模块职责

#### `registry.js`

注册 channel provider，声明能力：

```js
{
  id: 'telegram',
  mode: 'webhook' | 'polling',
  supportsInteractiveApproval: true,
  supportsThreads: false,
  supportsRichCards: true,
  supportsAttachments: true
}
```

#### `router.js`

把外部消息路由到内部能力：

- 普通助手对话 -> 现有 `chat-ui` / assistant service
- 代理任务指令 -> 现有 `agent-runtime`
- 审批回复 -> `resolveApproval`
- 问题回复 -> `answerQuestion`
- 取消任务 -> `cancelSession`

这里应做成“服务层调用”，而不是在服务内部回调 HTTP 接口。

#### `conversation-store.js`

保存 channel 会话映射关系：

```js
{
  channel: 'telegram',
  channelChatId: '123456',
  channelUserId: 'u_abc',
  localConversationId: 'conv_xxx',
  runtimeSessionId: 'session_xxx',
  mode: 'assistant' | 'agent-runtime',
  provider: 'codex' | 'claude-code'
}
```

它解决的问题是：

- 同一个手机会话继续发消息时应该续接哪一个本地 session
- 一条审批/提问回复应该落到哪个 runtime session
- 前端页面和移动端是否共享同一任务上下文

#### `delivery-store.js`

负责消息去重、出站确认和失败重试，最少应保存：

- inbound 去重 key
- last delivered event seq
- outbound message id
- retry count
- last error

#### `formatters.js`

将统一运行时事件渲染成不同 channel 能理解的消息形态：

- 文本摘要
- 命令执行状态
- 文件变更摘要
- 审批卡片 / 按钮
- 提问卡片 / 快捷回复
- 完成通知

#### `providers/telegram-provider.js`

职责：

- 校验 webhook / polling update
- 解析 chat id、user id、message text、callback action
- 发送文本、按钮、编辑消息

#### `providers/feishu-provider.js`

职责：

- 校验事件订阅
- 解析用户消息与 card action
- 发送文本、富卡片、审批动作

## 5. 数据流设计

### 5.1 入站

统一入站消息模型：

```js
{
  channel: 'telegram',
  accountId: 'default',
  externalMessageId: 'msg_xxx',
  externalChatId: 'chat_xxx',
  externalUserId: 'user_xxx',
  externalThreadId: '',
  text: '帮我启动 codex 修这个报错',
  raw: {}
}
```

入站流程：

1. channel provider 收到 webhook/polling 事件
2. 标准化为 `NormalizedChannelMessage`
3. 做去重和权限校验
4. 根据 conversation mapping 找到本地会话
5. 交给 `router.js`
6. router 决定调用 assistant 还是 `agent-runtime`

### 5.2 出站

统一事件来源：

- assistant reply
- `agent-runtime` SSE / event bus
- approval request
- question request
- task completed / failed

出站流程：

1. 订阅内部 reply/event
2. 转换为统一 `ChannelOutboundMessage`
3. 按 channel formatter 渲染
4. provider 发回 Telegram / 飞书
5. 写入 `delivery-store`

## 6. 与当前代码的衔接方式

### 6.1 不建议直接复用浏览器态

现在页面聊天依赖：

- 浏览器本地会话列表
- 前端 EventSource
- 当前 tab 的前台状态

这些都不适合手机 channel 直接复用。

因此要把“Web chat 是一个 channel”这个概念抽出来，而不是把 Telegram/飞书塞进 `public/js/app.js`。

### 6.2 建议新增服务层

当前 `agent-runtimes-route.js` 之下实际已经有 `session-manager`，这很好。对移动 channel 来说，还建议补一个更显式的应用服务层，例如：

```text
src/
  agent-orchestrator/
    message-service.js
```

建议提供统一方法：

- `routeUserMessage(input)`
- `createRuntimeSession(...)`
- `continueRuntimeSession(...)`
- `resolveRuntimeApproval(...)`
- `answerRuntimeQuestion(...)`
- `cancelRuntimeSession(...)`

这样：

- 浏览器 route 可以调它
- channel gateway 也可以调它
- 后面如果接 OpenClaw 风格的更多 channel，也不会把 HTTP route 变成业务中心

## 7. 会话管理

### 7.1 会话分两层

必须明确区分：

1. `channel conversation`
   外部消息通道上下文，例如 Telegram 某个 chat。
2. `runtime session`
   某一次 Codex / Claude Code 的执行会话。

一个 `channel conversation` 可以：

- 暂时只聊 assistant
- 某一轮触发新的 `runtime session`
- 任务完成后继续普通聊天
- 再次启动另一个 `runtime session`

不要把一个外部 chat 永久绑定成一个 runtime session。

### 7.2 需要的状态

建议 conversation state 至少包含：

- 当前模式：`assistant` / `agent-runtime`
- 当前活动 runtime session id
- 最近一次待处理审批 id
- 最近一次待回答问题 id
- 最后消息时间
- channel 元数据

### 7.3 长任务

长任务场景下要支持：

- 进程继续在服务端运行
- 用户离开网页或手机离线不影响任务
- 任务完成后主动通知对应 channel
- 用户稍后通过同一 chat 回复“继续”时可续接原 session

因此运行时状态必须保存在服务端，而不是只保存在前端。

## 8. 审批与提问桥接

这是移动 channel 接入的关键。

### 8.1 审批

当 Codex / Claude Code 请求权限时：

1. `agent-runtime` 发出 `approval.requested`
2. channel gateway 找到绑定的外部 conversation
3. 发出一条审批消息

优先形态：

- Telegram: Inline Keyboard 按钮
- 飞书: Card 按钮

回退形态：

- 发送文字说明
- 用户回复 `批准 123` / `拒绝 123`

### 8.2 提问

当下游 agent 需要用户补充信息时：

1. `question.requested`
2. 发送一条可回复消息
3. 用户直接在该 channel 回复
4. router 将回复写回 `answerQuestion`

### 8.3 完成与失败

要有主动推送，不依赖用户刷新页面：

- `task.completed` -> 发送完成通知和摘要
- `task.failed` -> 发送错误信息和下一步建议

## 9. 鉴权与安全

手机 channel 接入会把系统暴露到公网消息入口，安全设计必须前置。

### 9.1 sender allowlist / pairing

建议借鉴 OpenClaw 的 pairing 思路：

- 新 sender 首次发消息时不直接执行任务
- 先进入待配对状态
- 管理员在 Web 面板或指定管理 channel 中批准
- 批准后该 sender 才能继续使用

### 9.2 channel 级权限

至少区分：

- 只读通知
- 普通对话
- 可启动 agent-runtime
- 可审批高风险操作
- 管理员

### 9.3 webhook 安全

必须做：

- Telegram secret token 校验
- 飞书签名 / challenge 校验
- 入站幂等
- 频率限制
- 审批操作防重放

## 10. 推荐的落地顺序

### Phase 1: 内部抽象

先补内部抽象，不接外部 channel：

1. 抽出 `message-service`
2. 定义 `NormalizedChannelMessage` / `ChannelOutboundMessage`
3. 增加 `conversation-store`
4. 让 Web chat 作为第一个 channel 适配器的逻辑参考

### Phase 2: Telegram MVP

首个推荐 channel：`Telegram`

原因：

- API 简单
- webhook / polling 都成熟
- 交互按钮支持较好
- 手机端体验足够适合运维和远程控制

MVP 范围：

1. 收文本消息
2. 新建或续接 `agent-runtime`
3. 收到完成通知
4. 支持审批按钮
5. 支持问题回复

### Phase 3: 飞书

第二个 channel：`Feishu`

原因：

- 企业内部使用场景强
- 卡片交互能力好
- 适合团队审批和协作

当前实现建议：

- 首先支持 `webhook` 模式打通后端闭环
- 后续再补 `long connection` 作为更适合本地开发的增强模式

### Phase 4: 更多 channel

在 Telegram 与飞书稳定后，再扩展更多 channel。

本阶段不实现 WhatsApp、Signal、Slack 等 channel，但架构上要支持新增 provider 后平滑接入。

## 11. 技术难度评估

### 11.1 总体结论

这个需求是可做的，而且和你们当前已实现的 `agent-runtime` 非常匹配。

真正的难点不在 Codex / Claude Code，而在以下三件事：

1. 多 channel 的会话映射
2. 审批/提问事件的可靠桥接
3. 出站消息的幂等、重试与通知体验

### 11.2 分项难度

- Telegram: 中等
- 飞书: 中等偏上
- 未来新增 channel: 视 provider 协议而定

### 11.3 为什么不是特别重

因为你们已经把最难的一层做出来了：

- Codex / Claude Code 启动
- 结构化事件监控
- 审批和问题状态机
- 长任务 session

现在新增的是“消息入口/出口层”，不是重写执行内核。

## 12. 对现有代理功能的影响

只要遵循下面原则，就不会影响现有代理：

1. channel gateway 只调用 `agent-runtime` / assistant service，不改 `/v1/*` 与 `/backend-api/*` 语义。
2. 不把 channel 配置混进现有 provider 转发配置。
3. 不让 channel webhook 逻辑侵入模型请求链路。
4. 将消息接入与执行编排作为独立控制平面。

结果是：

- 现有 Codex / Claude Code 代理能力继续正常工作
- 页面聊天继续正常工作
- 手机 channel 只是新增入口，不会替换现有代理链路

## 13. 建议的首版范围

首版不要追求“多渠道全接入”，建议只做：

1. Telegram
2. 飞书
3. 仅 DM/单聊优先
4. 文本消息 + 审批按钮 + 完成通知
5. 对接现有 `agent-runtime`
6. conversation 映射持久化

首版先把闭环打通：

- 手机发起任务
- 服务端启动 Codex / Claude Code
- 执行中要求审批
- 手机上批准
- 任务继续执行
- 手机收到最终结果

这个闭环跑通后，再扩展飞书和更多 channel。

## 14. 下一步实现建议

建议按下面顺序推进：

1. 新增 `docs/channel-gateway-api.md`，定义统一消息模型和事件格式。
2. 抽出 `src/agent-orchestrator/message-service.js`。
3. 新增 `src/agent-channels/*` 基础骨架与 store。
4. 实现 `TelegramProvider`。
5. 新增 `/api/agent-channels/telegram/webhook` 与管理接口。
6. 在前端增加 channel monitor / pairing / sender 管理页面。
7. 再做飞书适配。
