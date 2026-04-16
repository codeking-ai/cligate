# CliGate Channel Gateway 实现设计

## 1. 目的

本文档用于指导 Telegram / 飞书渠道网关的实际实现，重点定义：

- 统一消息模型
- 可扩展的 provider 接口
- 与 `agent-runtime` / assistant 的对接方式
- 会话映射与长任务状态管理
- Telegram / 飞书的首版接入策略

本设计是对 [mobile-channel-gateway-design.md](D:\proxypool-hub\docs\mobile-channel-gateway-design.md) 的工程化细化。

## 2. 本阶段范围

本阶段只做：

- Telegram
- 飞书
- 单聊优先
- 文本消息
- 代理任务启动/续接
- 审批
- 提问
- 完成/失败通知

本阶段不做：

- 群聊复杂权限模型
- 语音/图片/文件桥接
- WhatsApp
- 多租户复杂组织隔离

## 3. 总体分层

```text
channel provider
  -> channel route / ingress
    -> channel router
      -> orchestrator message service
        -> assistant service or agent-runtime session manager
      -> outbound dispatcher
        -> channel formatter
          -> channel provider sender
```

职责拆分：

- `provider`
  渠道协议适配，收发消息。
- `router`
  决定这条消息是普通对话、启动任务、续接任务、审批、回答问题还是取消。
- `message service`
  内部业务编排服务，屏蔽 HTTP route。
- `outbound dispatcher`
  订阅内部事件并回推消息。

## 4. 推荐文件结构

```text
src/
  agent-orchestrator/
    message-service.js
  agent-channels/
    models.js
    registry.js
    router.js
    formatter.js
    outbound-dispatcher.js
    conversation-store.js
    delivery-store.js
    pairing-store.js
    providers/
      telegram-provider.js
      feishu-provider.js
  routes/
    agent-channels-route.js
```

## 5. 核心领域对象

### 5.1 Channel Provider Capability

```js
{
  id: 'telegram',
  mode: 'polling',
  supportsWebhook: true,
  supportsPolling: true,
  supportsInteractiveApproval: true,
  supportsRichCard: true,
  supportsThreading: false,
  supportsEditMessage: true
}
```

说明：

- `mode`
  当前启用的接入模式。
- `supportsWebhook`
  未来是否可切换到 webhook。
- `supportsInteractiveApproval`
  是否能用按钮交互审批。

### 5.2 NormalizedChannelMessage

所有入站消息在 router 前统一为：

```js
{
  channel: 'telegram',
  accountId: 'default',
  direction: 'inbound',
  deliveryMode: 'polling',
  externalMessageId: '123456789',
  externalConversationId: 'chat_123',
  externalThreadId: '',
  externalUserId: 'user_456',
  externalUserName: 'alice',
  text: '继续刚才的 codex 任务',
  messageType: 'text',
  action: null,
  ts: '2026-04-16T08:00:00.000Z',
  raw: {}
}
```

### 5.3 Channel Conversation

```js
{
  id: 'conv_xxx',
  channel: 'telegram',
  accountId: 'default',
  externalConversationId: 'chat_123',
  externalUserId: 'user_456',
  externalThreadId: '',
  mode: 'assistant',
  activeRuntimeSessionId: null,
  lastPendingApprovalId: null,
  lastPendingQuestionId: null,
  title: 'alice / telegram',
  metadata: {},
  createdAt: '',
  updatedAt: ''
}
```

关键原则：

- 一个 conversation 不是一个 runtime session。
- conversation 是长期入口。
- runtime session 是阶段性任务。

### 5.4 Channel Delivery Record

```js
{
  id: 'delivery_xxx',
  channel: 'telegram',
  direction: 'outbound',
  conversationId: 'conv_xxx',
  sessionId: 'session_xxx',
  eventSeq: 21,
  externalMessageId: 'tg_msg_789',
  status: 'sent',
  retryCount: 0,
  error: null,
  createdAt: '',
  updatedAt: ''
}
```

用途：

- 防止相同事件重复回推
- 支持失败重试
- 便于后续管理端查看通知状态

### 5.5 Pairing Record

```js
{
  channel: 'telegram',
  accountId: 'default',
  externalUserId: 'user_456',
  externalConversationId: 'chat_123',
  status: 'approved',
  code: '',
  requestedAt: '',
  approvedAt: '',
  approvedBy: 'admin'
}
```

## 6. 内部服务边界

### 6.1 新增 `message-service`

不建议让 Telegram / 飞书 provider 直接调用 route handler。

建议新增：

```js
messageService.routeUserMessage({
  source: {
    kind: 'channel',
    channel: 'telegram',
    conversationId: 'conv_xxx'
  },
  conversation,
  message
});
```

建议暴露方法：

- `routeUserMessage`
- `startRuntimeTask`
- `continueRuntimeTask`
- `sendAssistantReply`
- `resolveApproval`
- `answerQuestion`
- `cancelRuntimeSession`
- `bindRuntimeSessionToConversation`

### 6.2 对现有模块的调用关系

`message-service` 内部：

- 普通对话调用 `assistant-chat-service`
- 代理任务调用 `agent-runtime/session-manager`
- 审批/提问通过 `resolveApproval` / `answerQuestion`

这样浏览器 chat 和手机 channel 会共用相同的中间编排逻辑。

## 7. Router 设计

### 7.1 Router 输入

```js
async function routeInboundMessage(message)
```

### 7.2 Router 决策顺序

建议顺序：

1. 去重校验
2. pairing / allowlist 校验
3. 读取或创建 conversation
4. 判断是否为按钮回调
5. 判断是否命中待审批回复
6. 判断是否命中待提问回复
7. 判断是否是显式控制命令
8. 其余走智能路由

### 7.3 控制命令

建议首版支持固定控制命令，避免完全依赖模型理解：

- `/agent codex <task>`
- `/agent claude <task>`
- `/continue`
- `/cancel`
- `/status`
- `/approve`
- `/deny`

普通自然语言仍可保留，但首版建议先做命令优先解析。

原因：

- 手机端输入更短
- 能减少误判
- 审批和状态查询更稳定

## 8. Outbound Dispatcher 设计

### 8.1 事件来源

优先使用 `agent-runtime` 的 `eventBus`。

当前 `AgentRuntimeEventBus` 已经在内部 `emit('*', event)`，但没有对外公开统一订阅方法。建议补一个：

```js
subscribeAll(listener)
```

这样 `outbound-dispatcher` 可以全局监听任务事件，不需要每个 session 单独订阅。

### 8.2 Dispatcher 行为

当收到 runtime event：

1. 根据 `sessionId` 查 conversation binding
2. 根据事件类型决定是否通知
3. 组装统一 outbound payload
4. 走 formatter
5. 调用 provider 发送
6. 写 `delivery-store`

### 8.3 首版建议通知的事件

- `worker.started`
- `worker.approval_request`
- `worker.question`
- `worker.completed`
- `worker.failed`

以下事件首版不建议逐条推送，可做节流摘要：

- `worker.progress`
- `worker.command`
- `worker.file_change`

否则手机端消息会过多。

## 9. Formatter 设计

Formatter 输入统一为：

```js
{
  channel: 'telegram',
  conversation,
  event,
  session,
  context: {}
}
```

Formatter 输出：

```js
{
  text: 'Codex 任务已完成',
  parseMode: 'Markdown',
  buttons: [
    { id: 'continue', text: '继续' }
  ],
  card: null
}
```

### 9.1 Telegram 格式策略

首版：

- 文本为主
- 审批使用 inline buttons
- 状态消息可编辑更新

### 9.2 飞书格式策略

首版：

- 文本 + card
- 审批/问题尽量使用 card action
- 回退到文本指令

## 10. Store 设计

### 10.1 conversation-store

建议存放：

```text
<CONFIG_DIR>/agent-channels/conversations.json
```

能力：

- `findByExternal(channel, accountId, externalConversationId, externalUserId, externalThreadId)`
- `get(id)`
- `save(conversation)`
- `listByRuntimeSessionId(sessionId)`
- `bindRuntimeSession(conversationId, sessionId)`
- `clearActiveRuntimeSession(conversationId)`

### 10.2 delivery-store

建议存放：

```text
<CONFIG_DIR>/agent-channels/deliveries.jsonl
```

能力：

- `isInboundProcessed(key)`
- `markInboundProcessed(key)`
- `saveOutbound(record)`
- `listByConversation(conversationId)`

### 10.3 pairing-store

建议存放：

```text
<CONFIG_DIR>/agent-channels/pairing.json
```

能力：

- `getRequest(channel, externalUserId, externalConversationId)`
- `createRequest(...)`
- `approve(...)`
- `deny(...)`
- `isApproved(...)`

## 11. 渠道接入策略

### 11.1 Telegram

建议首版默认使用 `polling`：

- 更适合本地和内网环境
- 不要求一开始就暴露公网 webhook
- 实现成本最低

后续再补：

- webhook 模式
- 多 bot account
- 频道/群组策略

Telegram provider 建议职责：

- `start()`
- `stop()`
- `normalizeInbound(update)`
- `sendMessage(payload)`
- `editMessage(payload)`
- `answerCallback(payload)`

### 11.2 飞书

建议实现分两步：

1. 先用 `webhook` 模式打通收发与任务桥接
2. 再补 `long connection` 以优化本地开发体验

这样可以先完成业务闭环，再补更完善的接入体验。

飞书 provider 建议职责：

- `start()`
- `stop()`
- `normalizeInbound(event)`
- `sendMessage(payload)`
- `replyCardAction(payload)`

### 11.3 共性抽象

无论 Telegram 还是飞书，provider 都只负责：

- 渠道 SDK/API
- 协议校验
- 消息收发

provider 不负责：

- session 选择
- 智能路由
- 业务审批状态
- 运行时编排

## 12. 配置设计

建议新增 settings：

```js
{
  channels: {
    telegram: {
      enabled: false,
      mode: 'polling',
      botToken: '',
      pollingIntervalMs: 2000,
      allowedUsers: [],
      requirePairing: true
    },
    feishu: {
      enabled: false,
      mode: 'long-connection',
      appId: '',
      appSecret: '',
      encryptKey: '',
      verificationToken: '',
      allowedUsers: [],
      requirePairing: true
    }
  }
}
```

建议保存在独立文件，不与现有代理 provider 配置混写。

## 13. API / Route 设计

建议新增：

```text
GET  /api/agent-channels/providers
GET  /api/agent-channels/conversations
GET  /api/agent-channels/conversations/:id
POST /api/agent-channels/conversations/:id/reset
POST /api/agent-channels/pairing/:channel/:conversationId/approve
POST /api/agent-channels/pairing/:channel/:conversationId/deny
POST /api/agent-channels/telegram/webhook
POST /api/agent-channels/feishu/webhook
```

如果 Telegram 走 polling、飞书走长连接，则 webhook route 首版可以只预留，不立即启用。

还建议增加后台启动器：

```js
initializeAgentChannels(appContext)
```

服务启动时：

- 读取配置
- 初始化 enabled provider
- 绑定 outbound dispatcher

## 14. 状态机建议

### 14.1 Conversation 状态

```text
idle
assistant
agent_running
waiting_approval
waiting_question
completed
failed
```

说明：

- `conversation.mode` 是长期模式
- `runtime session status` 是底层执行状态
- 前端展示态可从两者推导

### 14.2 Inbound 处理状态

```text
received
deduped
authorized
routed
handled
failed
```

## 15. 首版实现顺序

### Step 1

补基础抽象：

- `src/agent-orchestrator/message-service.js`
- `src/agent-channels/models.js`
- `src/agent-channels/conversation-store.js`
- `src/agent-channels/delivery-store.js`
- `src/agent-channels/registry.js`

### Step 2

补事件桥：

- `eventBus.subscribeAll`
- `outbound-dispatcher.js`
- runtime session -> conversation binding

### Step 3

先做 Telegram：

- provider
- polling 启动器
- `/agent` `/continue` `/cancel`
- 审批按钮

### Step 4

再做飞书：

- provider
- long connection 启动器
- card action

### Step 5

最后补 Web 管理面板：

- channel 配置
- pairing 审批
- conversation 列表
- 运行中任务映射

## 16. 风险与注意事项

### 16.1 不要让 channel 直接调用 HTTP route

否则后续会出现：

- 内部业务逻辑散落在 route
- Web 与 channel 两套行为不一致
- 单元测试困难

### 16.2 不要让 provider 持有业务状态

状态应由 store 和 message service 统一管理。

否则后续切换 polling/webhook/long connection 时容易失控。

### 16.3 不要把每一条 runtime event 都推到手机

手机端更适合：

- 关键状态
- 审批
- 提问
- 完成结果

而不是完整终端日志镜像。

### 16.4 conversation 与 runtime session 必须解耦

否则任务结束后用户继续聊天会很难处理，也不利于未来一个 chat 内启动多个任务。

## 17. 设计结论

当前最合理的工程路线是：

1. 保持现有 `agent-runtime` 作为执行内核不变。
2. 新增 `message-service` 作为 Web 与 mobile channel 共享的编排入口。
3. 新增 `agent-channels` 作为独立消息网关层。
4. Telegram 先用 polling，飞书先用 long connection。
5. 先做关键状态消息桥接，不做终端全量复刻。

这样能用最小代价把 CliGate 从“网页聊天入口”扩展成“多端消息驱动的中间智能体”。
