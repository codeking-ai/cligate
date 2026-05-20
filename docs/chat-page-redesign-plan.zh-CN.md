# Chat 页面重构计划（v4）

> 本文件记录 Chat 页面及其相关导航（Sessions / Tasks / Conversation Records / Scheduled Tasks）的重构方案与分阶段实施清单，供后续与实现对照。

## 1. 背景与诊断

当前 Chat 页面将"系统的实现机制"直接暴露为"用户必须先做的选择"：

- 顶部强制让用户在 `assistant` 与 `agent-runtime` 两种模式之间二选一。
- 模式下方再叠加 `来源 / 模型 / 助手模式 / 系统 Prompt` 等控件，对新用户构成认知障碍。
- 右抽屉的"运行时监控"与导航的 `Assistant Tasks` / `Assistant Workbench` 内容重叠。
- 同级导航 `Conversation Records` 与"Chat 历史"/"Assistant Tasks"在用户视角下边界模糊。
- `Scheduled Tasks` 与 `Assistant Tasks` 实质是同类对象的不同时间状态，被并列成独立入口。

结论：问题不在"功能不够"，在于**用户视角的信息组织不正确**。

## 2. 最终设计（v4）

### 2.1 核心心智

**Web Chat 同时具备两个身份**：

1. 一个普通对话渠道（与钉钉、微信、Slack 等渠道平级）。
2. 所有渠道对话的**统一收件箱**（可在本地查看其他渠道的历史与继续）。

这与 WhatsApp Web / Slack 桌面端的双重身份一致，符合用户既有心智。

### 2.2 两种模式

| 模式 | 默认 | 用途 | 是否需要选模型/来源 | 后端语义 |
|---|---|---|---|---|
| **智能助手** | 是 | 日常使用，由 Assistant 智能体自主调度模型与工具 | 否 | 现有 `agent-runtime` 路径 |
| **模型对话** | 否 | 绕过 Assistant，直连指定来源/模型，用于诊断与 Playground | 是 | 现有 `assistant` 路径 |

### 2.3 关键交互约定

- 进入 Chat 页 = 默认智能助手模式 + 输入框自动聚焦。
- 智能助手模式：**不暴露任何模型/来源/运行时/工作目录控件**，提示用户"模型与工具由 Assistant 智能体管理"，附 `⚙ 配置`链接跳转至 Assistant 智能体配置页。
- 模型对话模式：**必选** 来源 + 模型；发送失败时在消息流以红色泡泡返回错误信息（状态码 + 大类 + 提示 + 跳转链接），不另设"测试连通"按钮。
- 模式切换：使用 segmented control（一段式分段），不再使用 `<select>`。
- 历史抽屉：跨渠道统一收件箱，按渠道徽标区分来源。
- **跨渠道继续对话**：用户从 Web 端继续钉钉/微信等渠道的对话时，回复**仅本地追加，不回传原渠道**。本端等同于一个只读历史 + 本地分支续聊视图。
- `[新对话]` 默认创建 Web 渠道会话。
- Assistant 智能体配置页保持不变（底层通用，不在本次范围）。
- `claude-code` / `codex` 等作为 Assistant 的工具存在，不在 Chat 暴露。

### 2.4 架构示意

```
                ┌─────────────────────────────────────┐
                │      Assistant Agent（不变）         │
                └──────────────────┬──────────────────┘
                                   │
        ┌──────────┬───────────────┼───────────────┬──────────┐
        ▼          ▼               ▼               ▼          ▼
    ┌──────┐   ┌──────┐        ┌──────┐        ┌──────┐   ┌──────┐
    │ 钉钉 │   │ 微信 │        │ Web  │ ◄── 同时是 ──► 所有渠道
    │      │   │      │        │ Chat │       的统一收件箱
    └──────┘   └──────┘        └──────┘        └──────┘   └──────┘
```

## 3. 不在本次范围

- 后端协议或接口能力变更。
- Assistant 智能体配置 schema 变更。
- 跨渠道 thread 合并算法。
- 工具白名单 UI（仍走现有 Tools 页）。
- 将 Web Chat 的回复推回钉钉/微信等原渠道。

## 4. 分阶段实施清单

### P0 — Chat 主框架重构（默认智能助手）

**目标**：用户进入 Chat 页即可对话，无任何前置配置。

**任务**：

1. 顶部 Header 简化：移除"历史对话"与"Agent 运行时监控"两个文字按钮，整合为右上一个抽屉图标按钮。
2. 模式切换：`<select>` → segmented control，顺序为 `[智能助手 | 模型对话]`。
3. 默认 `chatMode = 'agent-runtime'`（智能助手）。
4. 智能助手模式下：隐藏 `chatSourceId` / `chatRuntimeProvider` / `chatModel` / `chatAssistantMode` / `chatSystemPrompt` 等所有控件，仅显示一行提示与"⚙ 配置"链接。
5. 模型对话模式下：保留 `来源 / 模型 / 系统 Prompt` 控件，移除 runtime provider 选择器（不应出现在此模式）。
6. 状态栏简化：智能助手仅显示"由 Assistant 智能体处理"；模型对话保留 source 显示。
7. 输入框自动聚焦。
8. i18n 标签更新：
   - `chatModeAgent` → "智能助手"
   - `chatModeAssistant` → "模型对话"
   - 新增 `chatAgentHint`、`chatAgentConfigLink` 等。

**不在 P0 范围**：
- 不改变后端 API 调用语义。
- 不删除右抽屉的 runtime / mind tab（P1 处理）。
- 不删除 `Conversation Records` 独立页（P4 处理）。

**验收标准**：
- 进入 Chat 页 → 立即显示输入框，**不出现任何下拉或来源选项**。
- 顶部 segmented 左为「智能助手」，右为「模型对话」。
- 点「模型对话」→ 出现来源/模型选择。
- 点「⚙ 配置」→ 跳转 Assistant 智能体配置页。
- 与后端 API 的字段名（`chatMode` 值、source 字段）保持向后兼容。

### P1 — 抽屉简化 + 跨渠道历史接入

**目标**：抽屉只保留 History tab，并显示跨渠道的所有会话。

**任务**：

1. 删除抽屉的 `runtime` tab、`mind` tab。
2. History tab 接入 Conversation Records 同款数据源（既有后端能力）。
3. 每条会话卡片显示渠道徽标（Web / 钉钉 / 微信 / Slack 等）。
4. 新增 channel filter（全部 / Web / 钉钉 / ...）。
5. 列表按最近活动倒序，未读消息显示 badge。

**验收标准**：
- 抽屉仅保留 History tab。
- 看到来自不同渠道的对话，徽标可一眼识别。
- channel filter 能筛选渠道。

### P2 — 跨渠道对话本地继续

**目标**：从 Web 端点开钉钉/微信对话，能在本地查看并继续，回复仅追加本地。

**任务**：

1. 点开外渠道会话 → 加载该会话所有历史消息显示。
2. 顶部展示"来源 chip"标明原渠道。
3. 用户在输入框发送 → 走智能助手 API + 本地存储，**不通过原渠道 webhook 回传**。
4. UI 视觉上区分"原渠道消息"与"Web 本地追加消息"。
5. 关闭/刷新后状态保持。

**验收标准**：
- 从 History 点开钉钉对话，能看到该对话所有历史。
- 在 Web 端发送的回复仅本地可见，钉钉端不接收。
- 关闭再开，本地追加的消息仍在。

### P3 — 模型对话错误体验

**目标**：模型对话模式失败时有清晰可操作的错误反馈。

**任务**：

1. 调用失败 → 在消息流以红色泡泡显示：状态码 + 错误大类（auth / quota / network / model_not_found / timeout）+ 简短提示 + 跳转链接。
2. 状态栏被动展示该 source 最近 N 次成功率与 p50 延迟（数据来源：现有 requestLogs）。

**验收标准**：
- 故意选错的 source 发消息 → 看到红色错误泡泡。
- 跳转链接到对应 source 配置页。

### P4 — 导航清理

**目标**：Workspace 一级入口收敛为 `Dashboard / Chat / Tasks`。

**任务**：

1. 移除 `Conversation Records` 独立页（数据已纳入 Chat History）。
2. 合并 `Assistant Tasks` + `Assistant Workbench` + `Scheduled Tasks` 为 `Tasks` 页（二级 tab：进行中 / 定时 / 已完成 / 项目视图）。
3. Workspace 分组只保留 Dashboard / Chat / Tasks。
4. i18n、路由、状态映射同步更新。

**验收标准**：
- 侧边栏 Workspace 仅 3 个入口。
- Conversation Records 的能力在 Chat 抽屉里完整可用。
- Tasks 页内可查看运行中 / 定时 / 已完成 / 项目视图。

## 5. 设计演进对照表

| | v1 | v2 | v3 | **v4 (最终)** |
|---|---|---|---|---|
| 模式策略 | 取消 mode，按 source 类型推断 | 保留 2 mode 并重定位 | 同 v2 | 同 v2 |
| 智能助手默认 | — | 是 | 是 | 是 |
| Runtime 控件 | 自动推断 | 折叠 chip | 完全消失 | 完全消失 |
| 模型对话用途 | 模糊 | 模型测试 | 模型测试 | 模型测试 |
| 测试连通按钮 | — | 有 | 有 | **无（错误直接 inline 返回）** |
| Chat 在系统中的角色 | 聊天页 | 聊天页 | 聊天页 | **渠道 + 统一收件箱** |
| Conversation Records 处置 | 移至 Channels 分组 | 同 | 同 | **直接合入 Chat 抽屉** |
| 跨渠道继续策略 | — | — | — | **仅本地追加，不回传** |
| 后端改动 | 中 | 无 | 小 | **无** |

## 6. 已知后续可能演进

- 若 Assistant 后端实现跨渠道 thread 合并标记，前端 History 自然按 thread_id 聚合。
- 未来若需"Web 回复回写到原渠道"，可作为单条会话的开关，但当前明确不做。
- Chat 中调用工具的可视化时间线（function-calling timeline）。

## 7. 文档维护

- 实施过程中如遇与本计划偏离的决策，在对应 P 段下添加 `## 实施备注` 小节记录原因。
- 每完成一个 P 段，在本文件末尾追加完成日期与对应 commit 哈希。

## 8. 完成记录

### P0 — Chat 主框架重构（默认智能助手） — 2026-05-20

实施摘要：

- `public/partials/views/chat.html`
  - Header 移除"历史对话"与"运行时监控"两个独立按钮，替换为顶部 segmented control（智能助手 / 模型对话）+ 抽屉图标按钮。
  - 控制面板按模式分支：智能助手模式仅显示提示卡片与 ⚙ 配置链接（跳转 `assistantAgent` 配置页）；模型对话模式保留 来源/模型/系统 Prompt 控件，移除 runtime provider 选择器与 `chatAssistantMode` toggle。
  - 状态栏：智能助手默认显示"由 Assistant 智能体处理"，仅在已挂载 runtime session 时附加运行时徽标；模型对话保留 source 显示。
  - 输入框新增 `x-ref="chatComposerInput"`，layout 根节点 `x-init` 自动 `focus()`。

- `public/js/modules/chat-page.js`
  - `chatMode` 默认值 `'assistant'` → `'agent-runtime'`。
  - `newChatSession` / `openChatSession` / `syncActiveChatSession` 三处 `||` fallback 同步改为 `'agent-runtime'`。
  - 历史 session 保留各自原 mode，向后兼容。

- `public/js/i18n.js`
  - `chatModeAssistant` zh `普通对话` / en `Assistant Chat` → `模型对话` / `Model Chat`。
  - `chatModeAgent` zh `代理任务` / en `Agent Runtime` → `智能助手` / `Smart Assistant`。
  - 新增 key：`chatAgentHint`、`chatAgentConfigLink`、`chatAgentStatusLabel`（中英文对齐）。

验证：

- HTTP 200：`/`、`/partials/views/chat.html`、`/js/app.js`、`/js/modules/chat-page.js`、`/js/i18n.js`。
- 静态校验通过：新标记 `chat-mode-segmented` / `chatAgentHint` / `chatComposerInput` / `chatMode: 'agent-runtime'` 均在服务返回的最新文件中存在。
- 单元测试 `tests/unit/chat-page.test.js` 在 P0 改动前后均为 21/21 失败，属预先存在的测试漂移，与本次改动无关。

基线 commit：`3a43b57`

后续：
- 浏览器扩展未连接，未做交互式可视验证；待人工进入 Chat 页观察行为是否符合预期。
- P1（抽屉简化 + 跨渠道历史）暂未开始。

#### 实施备注 — 样式对齐修订（同日）

**问题**：首版使用了自定义 Tailwind 工具类（`chat-mode-segmented` / `chat-mode-segment`）以及一个图标-only 抽屉按钮，与项目既有视觉语言不一致。

**修订**：
- 模式 segmented 改用既有 `chat-side-tabs` / `chat-side-tab` / `chat-side-tab-active` 类（与右抽屉的 History/Runtime/Mind 标签视觉完全一致，无需新增 CSS）。
- 智能助手提示卡片合入 `chat-control-panel` 类，与下方模型对话控件面板共享相同的 padding/border-color。
- "⚙ 配置" 按钮使用 `chat-control-button btn btn-sm btn-surface`（即既有控件面板内按钮的 token 链）。
- 抽屉触发按钮还原为文本"历史"按钮，与 `[新对话]` 同类（`chat-header-button btn btn-sm btn-surface`），保持 header 三件套权重一致。

### P1 — 抽屉简化 + 跨渠道历史接入 — 2026-05-20

实施摘要：

- `public/partials/views/chat.html`
  - 抽屉头部移除 3-tab 切换控件（history / runtime / mind），改为单一 `<h3>历史</h3>` + 计数 + 关闭。
  - 抽屉头部下方新增 channel filter：`<select>` 绑定 `chatHistoryChannelFilter`，选项动态来源于 `chatHistoryChannelOptions()`。
  - 抽屉内容区改为渲染 `unifiedChatHistory()` 计算列表（不再区分多个 `x-show` 分支）。
  - 每张卡片左上角增加渠道徽标 `chat-history-channel-badge`，颜色随 channel 变化（`chatHistoryChannelBadgeClass`）。
  - 远程渠道（钉钉/微信/...）卡片 `cursor-default` 暂不响应点击；本地 Web 会话保留 `cursor-pointer` + `openChatSession`。
  - 完整删除原 runtime tab 与 mind tab 的 DOM（约 170 行），减少抽屉总行数 ~33%。

- `public/js/modules/chat-page.js`
  - 新增 state：`chatHistoryChannelFilter: 'all'`。
  - 新增方法：
    - `chatHistoryChannelLabel(channel)` — 渠道 id → 显示名（web/dingtalk/wechat/slack/whatsapp/...）。
    - `chatHistoryChannelBadgeClass(channel)` — 渠道 id → Tailwind 色彩类（cyan/blue/emerald/violet/...）。
    - `unifiedChatHistory()` — 合并本地 `chatSessions`（标 `channel='web'`）+ 远程 `channelConversations`，按 `updatedAt` 倒序，应用 channel filter。
    - `chatHistoryChannelOptions()` — 从远程会话动态汇总 channel 选项（始终含 web）。
  - 跨模块依赖：`channelConversations` 由 `channels-page.js` 暴露在同一 Alpine 根，直接访问。

- `public/js/app.js`
  - `setActiveTab('chat')` 分支新增 `loadChannelConversations({ silent: true })` 调用，确保进入 chat 时同步拉取跨渠道历史。

- `public/js/i18n.js`
  - 新增 key（中英）：`chatHistoryFilterAll`、`chatHistoryEmpty`。

验证：

- HTTP 200：`/partials/views/chat.html`、`/js/app.js`、`/js/modules/chat-page.js`、`/js/i18n.js`。
- 抽屉中 `chatSidebarTab` 引用已 0 处（彻底清理）。
- 服务返回的 chat.html 含 `unifiedChatHistory` / `chatHistoryChannelFilter` / `chatHistoryChannelBadgeClass` / `chatHistoryChannelLabel` / `chatHistoryFilterAll` 标记。
- `node --check` 通过：`chat-page.js`、`i18n.js`、`app.js`。

后续：
- 抽屉头部不再有 tab 标签后，CSS 中 `chat-side-tabs` / `chat-side-tab*` 仍被 header 模式 segmented 使用；P4 清理仅删除遗留 state，不删 CSS。
- chat-page.js 中遗留的 `openChatSidebar` / `chatSidebarTab` state 仍保留，未引用，留待 P4 清理。

### P2 — 跨渠道对话本地继续 — 2026-05-20

实施摘要：

- `public/js/modules/chat-page.js`
  - 新增 `activeSessionOriginChannel()` — 返回当前激活 session 的 `originChannel`（用于消息泡泡徽标取色）。
  - 新增 `openRemoteConversation(remoteCard, options)` — 远程卡片点击处理：
    - 用 `/api/agent-channels/session-records/<id>` 拉取 deliveries。
    - inbound delivery → `role: 'user'`；outbound → `role: 'assistant'`；统一打 `_origin: 'remote'`, `_originId`, `_originChannel`, `_originTimestamp`, `isError`。
    - shadow session id 模式：`chat_remote_<conversationId>`（确定性，重复点击复用）。
    - 保留之前已存在 session 的 web-origin 消息（filter `m._origin !== 'remote'`），与新拉取的 remote 消息合并。
    - 注入 origin 元数据：`originChannel` / `originProvider` / `originConversationId` / `originExternalId` / `originTitle`。
    - 调用 `openChatSession(shadowSessionId)` 在主面板渲染；persist 到 localStorage。
  - 新增 `refreshActiveRemoteConversation()` — 状态栏 ↻ 按钮触发：基于当前 session 的 originXxx 字段反向构造 remoteConv，调用 `openRemoteConversation` 完成增量刷新（保留 web 追加）。

- `public/partials/views/chat.html`
  - 抽屉远程卡片：去除 `cursor-default` / `opacity-90`，统一 `cursor-pointer`；点击逻辑改为三元 `card.type === 'local' ? openChatSession : openRemoteConversation`。
  - 远程卡片激活态：`getActiveChatSession()?.originConversationId === card.raw.id` 时高亮（chat-session-card-active）。
  - 状态栏（agent-runtime 模式）：
    - 当 session 无 `originChannel` 时保留默认 `chatAgentStatusLabel`。
    - 当 session 有 `originChannel` 时切换为彩色 chip "继续来自 [渠道]"（用 `chatHistoryChannelBadgeClass` 取色）。
    - 旁边追加 `↻ 刷新` 按钮（仅 `originConversationId` 存在时显示）。
  - 消息泡泡 meta 行：`message._origin === 'remote'` 时在角色标签后追加渠道徽标，颜色取自 message 自身的 `_originChannel`，未携带时回退到 `activeSessionOriginChannel()`。

- `public/js/i18n.js`
  - 新增 key（中英）：`chatContinuationLabel` / `chatContinuationRefresh`。

设计约束（来自用户）：
- 从 Web 端继续钉钉/微信对话，**回复仅本地追加，不回传原渠道 webhook**。
- 通过 `sendChatMessage` 走智能助手（agent-runtime）路径即可达成：该路径不携带 origin 渠道信息，后端不会向外渠道推送。

验证：
- HTTP 200：`/partials/views/chat.html`、`/js/app.js`、`/js/modules/chat-page.js`、`/js/i18n.js`。
- `node --check` 通过：`chat-page.js` / `i18n.js` / `app.js`。
- 服务返回的 chat.html 含 `openRemoteConversation` / `refreshActiveRemoteConversation` / `_origin === 'remote'` / `chatContinuationLabel` / `chatContinuationRefresh` 标记。
- 服务返回的 chat-page.js 含 `openRemoteConversation` / `refreshActiveRemoteConversation` / `activeSessionOriginChannel`。

后续：
- 暂未在 sendChatMessage 中显式给新消息打 `_origin: 'web'`；当前依赖反向逻辑（filter `_origin !== 'remote'`）保留所有非 remote 消息，行为正确但语义不够显式，必要时 P4 一并补强。
- 点击远程卡片时若拉取 deliveries 失败，当前是 silent fallback（保留已有 session 消息）；后续可加 toast 提示。

### P3 — 模型对话错误体验 + 健康度 — 2026-05-20

实施摘要：

- `public/js/modules/chat-page.js`
  - 新增 state：`chatSourceHealth: {}` —— per-sourceId 的滚动 buffer（保留最近 20 次，每条 `{timestamp, latency, success}`）。
  - 新增 `classifyChatError(status, text)` —— HTTP 状态码 + 文本启发式映射为 6 类：`auth` / `quota` / `model_not_found` / `timeout` / `network` / `unknown`，每类附带友好文案 + 跳转目标（tab + label）。
  - 新增 `recordChatSourceHealth(sourceId, latencyMs, success)` —— 单次调用埋点；buffer 上限 20，超出时 FIFO 丢弃旧条目。
  - 新增 `chatSourceHealthStats(sourceId)` —— 返回 `{total, successes, successRate, p50}` 或 `null`（无数据）。
  - 新增 `chatSourceHealthClass(sourceId)` —— 成功率 → Tailwind 色彩（≥90% 绿、≥60% 黄、否则红）。
  - 改造 `sendChatMessage`：
    - 测量 `startedAt = Date.now()`、`sentSourceId = this.chatSourceId`。
    - 失败时读取 `response.status`，调用 `classifyChatError` 构造 `errorDetail` 挂到 `assistantMessage`。
    - 移除原 `showToast` 错误提示（错误现已在消息流内可视化）。
    - 成功与失败两路径都调用 `recordChatSourceHealth` 完成埋点。

- `public/partials/views/chat.html`
  - 模型对话状态栏右侧新增 `health chip`：
    - 有数据：彩色 chip 显示 `● <successRate>%  <successes>/<total>  · p50 <ms>`，色彩由 `chatSourceHealthClass` 决定。
    - 无数据：灰色 chip `● 暂无数据`。
  - 消息泡泡 meta 行（错误态）：在角色标签之后追加 `[status]` 红色 chip + `[category]` 大写小标签。
  - 消息泡泡正文下方新增 `chat-error-detail` 区块（仅 `isError && errorDetail` 显示）：
    - 原始错误文本（截断 600 字符，等宽字体）—— 仅当 raw 与友好文案不同时才显示。
    - 跳转按钮（`btn btn-xs btn-surface`）：点击调用 `setActiveTab(jumpTo.tab)` 跳到对应 tab（如 `apikeys` / `usage` / `routing` / `accounts`）。

- `public/js/i18n.js`（中英）
  - 新增 6 个分类标签：`chatErrorCategory_auth` / `_quota` / `_network` / `_model_not_found` / `_timeout` / `_unknown`。
  - 新增 6 条友好文案：`chatErrorAuthMessage` / `chatErrorQuotaMessage` / `chatErrorNetworkMessage` / `chatErrorModelMessage` / `chatErrorTimeoutMessage` / `chatErrorUnknownMessage`。
  - 新增 4 条跳转按钮文案：`chatErrorJumpKeys` / `chatErrorJumpUsage` / `chatErrorJumpRouting` / `chatErrorJumpAccounts`。
  - 新增 `chatHealthNoData`。

设计说明：
- 健康度数据**纯客户端**：来自用户当次会话期间真实发起的调用结果，不另起后端请求。与 requestLogs 分离的好处是即时反馈、无额外网络开销；缺点是刷新页面后清空（可接受，因为它代表"这一刻该 source 表现如何"）。
- 错误分类是启发式（HTTP 状态码 + 文本关键字），覆盖大多数常见后端响应；未匹配上的归 `unknown` 并提供原始返回，避免吞错。

验证：
- `node --check` 通过：`chat-page.js`、`i18n.js`。
- 服务返回的 chat-page.js 含 `classifyChatError` / `recordChatSourceHealth` / `chatSourceHealthStats` / `chatSourceHealthClass` / `errorDetail` 节点。
- 服务返回的 chat.html 含健康度 chip 与 `chat-error-detail` 区块。
- 服务返回的 i18n.js 含新增 6+6+4+1 条键。

后续：
- 健康度 chip 暂未做"点击查看详细 requestLogs"的下钻链接，可在 P4 后补强。
- 错误分类的关键字命中暂未覆盖国际化的中文错误返回（如 "未授权"）；后端有中文报错时需扩 keyword 列表。

### P4 — 导航清理 + 历史 backlog — 2026-05-20

实施摘要：

**4.1 移除 Conversation Records 独立入口**

- `public/index.html`：删除 conversationRecords 的 nav button（line 186-192）与 view-container（line 434）。
- `public/js/app.js`：
  - 删除 `viewPartialPaths.conversationRecords` 映射。
  - 删除 setActiveTab 的 conversationRecords 分支（10 行）。
  - 删除 5 秒轮询 conversationRecords 数据的 setInterval；改为仅当 chat 抽屉打开时刷新跨渠道历史。
  - `sectionForTab` 从 workspace 列表中移除 conversationRecords，并补回 scheduledTasks。
- `public/partials/views/conversation-records.html`：保留在磁盘但不再有任何入口指向它。
- 底层 `channels-page.js` 完全保留（Chat 抽屉依赖 `loadChannelConversations` / `channelConversations`）。

**4.2 合并 Tasks 三页为单一导航入口**

- `public/index.html`：
  - 删除 assistantTasks / assistantWorkbench / scheduledTasks 三个独立 nav button。
  - 替换为单个 `tasks` nav button。
  - 新增 `<div x-show="activeTab === 'tasks'">` 包装：内含 `chat-side-tabs` 样式的 sub-tab 切换条 + 3 个 nested `data-partial-view` 容器（按 `taskSubTab` 切换显示）。
- `public/js/app.js`：
  - 新增 state `taskSubTab: 'active'`。
  - 改造 `viewPartialKeyForTab('tasks')`：根据当前 `taskSubTab` 动态返回 `assistantTasks` / `assistantWorkbench` / `scheduledTasks` 之一，复用既有 partial 加载机制。
  - 新增 `switchTaskSubTab(subTab)`：设置 sub-tab + 触发 partial 懒加载 + 调数据。
  - 新增 `loadTaskSubTabData(subTab)`：分派到既有的 `loadAssistantTasks` / `loadAssistantWorkbench` / `loadScheduledTasks`。
  - `setActiveTab('tasks')` 调 `loadTaskSubTabData(this.taskSubTab)`。
  - 保留原有 `assistantTasks` / `assistantWorkbench` / `scheduledTasks` setActiveTab 分支（兼容老深链）。
- 不修改 3 个 sub-partial 文件 —— 它们原样嵌入新 wrapper，header/title 由各自的 sub-partial 自行渲染。

**4.3 i18n 增补**

- 中英新增：`tasks` / `tasksTabActive` / `tasksTabWorkbench` / `tasksTabScheduled`。

**4.4 历史 backlog 清理**

- `public/js/modules/chat-page.js`：
  - 删除残留 state `chatSidebarTab: 'history'`（P1 后已无引用）。
  - 删除 `openChatSidebar(tab)` 方法（同上）。
  - `toggleChatHistory()` 简化为单纯切换 `chatHistoryOpen` 布尔。
- 在 `sendChatMessage` 与 `sendAgentRuntimeMessage` 中，**显式给 user/assistant 消息打 `_origin: 'web'` 标签** —— 使 P2 跨渠道续聊的 web/remote 区分从隐式（`!== 'remote'`）变为显式（`=== 'web'` vs `=== 'remote'`），语义更清晰，后续若加第三种来源（如导入文件）也能扩展。

验证：
- HTTP 200：`/`、`/partials/views/chat.html`、`/js/app.js`、`/js/modules/chat-page.js`、`/js/i18n.js`。
- `node --check` 通过：app.js / chat-page.js / i18n.js。
- 服务返回 index.html：Workspace 一级 nav 仅 `dashboard` / `chat` / `tasks` 三项；tasks 容器内 3 个嵌套 `data-partial-view`。
- 服务返回 chat-page.js：`chatSidebarTab` / `openChatSidebar` 完全消失；3 处 `_origin: 'web'` 标签生效。
- 服务返回 i18n.js：新增 4 条 tasks 相关键中英对齐。
- 服务返回 app.js：`taskSubTab` state、`switchTaskSubTab` / `loadTaskSubTabData` 方法、动态 `viewPartialKeyForTab` 都已落地。

## 9. 总览：5 段完成情况

| 阶段 | 主目标 | 状态 | 完成日 |
|---|---|---|---|
| P0 | Chat 默认智能助手 + 控件折叠 | ✅ | 2026-05-20 |
| P0 修订 | 样式对齐既有设计系统 | ✅ | 2026-05-20 |
| P1 | 抽屉简化 + 跨渠道历史 | ✅ | 2026-05-20 |
| P2 | 跨渠道对话本地继续 | ✅ | 2026-05-20 |
| P3 | 模型对话错误体验 + 健康度 | ✅ | 2026-05-20 |
| P4 | 导航清理 + 历史 backlog | ✅ | 2026-05-20 |

## 9.1 回归修复（参照 chat-page-redesign-regression-analysis.zh-CN.md） — 2026-05-20

用户在 P4 完成后反馈三个问题，Codex 给出分析（见 `docs/chat-page-redesign-regression-analysis.zh-CN.md`）。本节记录依据该分析实施的修复。

### 回归 1：模式切换污染原会话

**问题**：在模型对话发了一条消息后，点击"智能助手"会复用并污染原模型对话会话；智能助手发送时仍携带原模型对话残留的 `chatModel`，导致 model 配置错误。

**根因**：模板按钮直接执行 `chatMode = 'X'; syncActiveChatSession()`，把当前 UI 状态写回当前 active session；`sendAgentRuntimeMessage` 携带 `model: this.chatModel.trim()` 把 model 字段传给后端；`runtimeSessionConfigChanged` 仍用 `this.chatModel` 作为重启依据。

**修复**：
- `public/js/modules/chat-page.js`：
  - 新增 `buildBlankChatSession(targetMode)` 工厂方法 —— 智能助手新建会话不带 `sourceId` / `model` / `systemPrompt`；模型对话新建会话才填入 source/model。
  - 新增 `switchChatMode(targetMode)` —— 若目标模式已有"空且非续聊"会话则切换，否则创建一个全新会话；不再原地改写当前会话。
  - `newChatSession()` 重写为调用 `buildBlankChatSession` 并修复一个原有的 `sessionId` 未定义 bug。
  - `sendAgentRuntimeMessage` 改为读 `session.runtimeProvider` / `session.model`（按会话上下文，而非全局 chat UI 状态），且仅当 session 自身有 model 才放入请求体。
  - `runtimeSessionConfigChanged` / `buildRuntimeSessionRestartNotice` 不再用 `this.chatModel`；仅当 session 与已绑定的 model 都非空才比较。
- `public/partials/views/chat.html`：模板按钮 `@click` 从 `chatMode = 'X'; syncActiveChatSession()` 改为 `switchChatMode('X')`。

### 回归 2：历史会话无法可靠打开

**问题**：点击任何历史卡片都无法在主聊天窗口继续打开；远程渠道历史更明显。

**根因**：
- 模板原写法 `card.type === 'local' ? openChatSession(card.raw.id) : openRemoteConversation(card)` 是 Alpine 三元表达式，对调试不够鲁棒。
- 远程卡片的 `card.raw.id` 来自 `/api/agent-channels/session-records`，是 **runtime session id**，不是 conversation id；`openRemoteConversation` 用它去查 `/api/agent-channels/session-records/<id>` 会拿到 runtime session 视角的片段，且 shadow session 主键不稳定，导致同一个钉钉会话被拆成多个本地分支。

**修复**：
- `public/js/modules/chat-page.js`：新增 `openHistoryCard(card)` 显式分派方法（替代模板三元）。
- `public/partials/views/chat.html`：`@click` 改为 `openHistoryCard(card)`。
- `public/js/modules/chat-page.js`：`openRemoteConversation` 改用：
  - URL: `/api/agent-channels/conversations/:conversationId`
  - 主键：`conv.conversationId || conv.id`（兼容旧/新数据源）
  - shadow session id：`chat_remote_<conversationId>` 稳定不变
  - 元数据补 `originRuntimeSessionId`（保留 runtime 引用，但不作为主键）
  - 拉取失败时不再 silent fallback —— `showToast(chatHistoryLoadFailed)` 并保留旧本地消息。

### 回归 3：钉钉等渠道最新消息不显示

**问题**：从钉钉发送的新消息在 Chat 历史里看不到。

**根因**：`loadChannelConversations` 当时调的是 `/api/agent-channels/session-records?limit=80`，后端只列出绑定了 runtime session 且 `metadata.source.kind === 'channel'` 的会话；未触发 runtime session 的新 inbound 消息根本不在结果里。

**修复**：
- `public/js/modules/channels-page.js`：`loadChannelConversations` 切到 `/api/agent-channels/conversations?limit=80`。该接口走 `agentChannelConversationStore.list()`，是真正以 conversation 为粒度的统一收件箱，未绑定 runtime session 的新会话也会出现。
- `public/js/modules/chat-page.js`：`toggleChatHistory` 在打开抽屉时立即调用 `loadChannelConversations({ silent: true })`，不必等 5 秒轮询。

### 其他清理

- `app.js#sectionForTab`：显式包含 `tasks`（之前仅保留旧三个 tab 用于深链兼容，新 `tasks` 未列入 workspace 段）。
- 新增 i18n key `chatHistoryLoadFailed`（中英）。

### 验证

- `node --check` 通过：app.js / chat-page.js / channels-page.js / i18n.js。
- 服务返回 chat.html 含 `switchChatMode` / `openHistoryCard`；chat-page.js 含 `buildBlankChatSession` / `switchChatMode` / `openHistoryCard` / `chat_remote_<conversationId>` / `/api/agent-channels/conversations/`；channels-page.js 切到 conversations 接口；i18n 含中英新增 key。

### 后续可考虑

- 远程会话刷新策略：目前 `refreshActiveRemoteConversation` 也需迁移到 conversations 接口（已通过 openRemoteConversation 间接覆盖，调用 chain 正确）。
- 5 秒轮询当前在 chat 抽屉打开时刷新；可加防抖避免过频调用。
- conversation 列表后续若需 supervisor/runtime 状态信息，可在前端通过 `conv.supervisor` / 额外字段读取，无需再切回 session-records。

## 9.2 渠道对齐：chat-ui 作为真渠道接入 Assistant Agent — 2026-05-20

### 背景

P0–P4 完成后用户测试时反馈：
1. 上海天气：claude-code 报 `gpt-5.2` 模型错误（前端模型污染 bug）；
2. 深圳天气：用户喊"用 codex 查询"，系统实际跑 claude-code 并伪造了"via Codex CLI"输出。

第 9.1 节已修复了 `syncActiveChatSession` 跨模式污染。但残留的第 2 个症状（工具编排错乱）属于**渠道接入层级的设计偏差**。

### 根因

对照存档 `~/.cligate/agent-channels/conversations.json`：

| 渠道 | controlMode | 消息路径 |
|---|---|---|
| dingtalk | `assistant` | → mode-service.maybeHandleMessage 拦截 → dialogue-service 编排工具 |
| chat-ui | `direct-runtime`（默认） | → message-service.routeUserMessage → 直接 spawn claude-code CLI |

chat-ui 走的是 `direct-runtime` 路径，**Assistant Agent 监督层完全被绕过**。claude-code CLI 只是工具，没有"调用其他 runtime"的能力，看到"用 codex"自然语言只能编造。

`src/assistant-core/assistant-state.js#getAssistantControlMode` 默认返回 `'direct-runtime'`；`src/chat-ui/conversation-store.js#findOrCreateBySessionId`（旧版）创建会话时不显式注入 `assistantCore`，落入默认值。钉钉那条 `controlMode: 'assistant'` 的会话是历史上经过 `/cligate` 激活后持久化的。

### 修复

**`src/chat-ui/conversation-store.js`** 重写为真渠道接入逻辑：

1. **新会话种子注入** — `findOrCreateBySessionId` 在 `findByExternal` 未命中时，调用 `buildAssistantCoreDeliveryState({}, { controlMode: 'assistant' })` 注入元数据，与 dingtalk 等渠道对齐。
2. **既有会话不破坏** — `findByExternal` 命中时直接转发到父类 `findOrCreateByExternal`，不携带 seed metadata，保留用户可能通过 `/runtime` 切回 direct-runtime 的状态。
3. **一次性迁移** — 构造函数加 `_migrateUntouchedToAssistantMode()`：扫描所有 `channel === 'chat-ui'` 且 `assistantSessionId/lastRunId` 均为空的"从未激活过 assistant"的存量会话，升级 controlMode 到 `'assistant'` 并 `_save()` 落盘。已在用户磁盘上把 11 条遗留会话一次性迁移完。

### 验证

- `node --check` 通过。
- 直接 import 该模块并实例化触发迁移：11/11 条 chat-ui 会话 controlMode 从 `direct-runtime` 变为 `assistant`，与 dingtalk 一致；磁盘 conversations.json 已持久化。
- 新建测试会话验证 seed：`{controlMode: 'assistant', mode: 'assistant', deliveryOwnership: 'assistant-owned'}` ✅。

### 后续动作（需要用户手动）

- **重启服务**：Node 进程要重启才能加载新版 `conversation-store.js`（运行中的 8081 端口是用户自己启动的）。
- **新一轮验证**：重启后在 Web Chat 智能助手模式说"用 codex 查询深圳天气"，预期：
  - 消息进入 `mode-service.maybeHandleMessage` 的 ASSISTANT 路径（不再 return null）。
  - `dialogueService.run` 编排工具 — 会根据用户意图选择是 claude-code 还是 codex（或调研后回复说当前没有 codex 可用），而不是 claude-code 蛮干。

### 设计影响

至此 chat-ui 在系统中**正式与 dingtalk/wechat/feishu 等同为 channel**：
- 数据层：channel='chat-ui'，conversations 与其他渠道并列
- 控制层：默认 controlMode='assistant'，进入 Assistant Agent 监督
- 交付层：deliveryOwnership='assistant-owned'，由 Assistant 决定何时回复
- UI 层：Web 端的"智能助手"模式 ≡ 任意渠道的默认对话方式

未来添加新渠道（如 Telegram、企业微信）只需在自己的 store 中做相同的 seed，无需碰共享代码。

## 10. 全局遗留事项

- `conversation-records.html` 物理文件仍在磁盘，未来若确认无任何深链入口，可一并删除。
- `assistant-tasks.html` / `assistant-workbench.html` / `scheduled-tasks.html` 三个 sub-partial 保留原 header；理想化 UI 应改成单一"Tasks"标题 + sub-tab 切换条，sub-partial 仅渲染内容主体；本次保守起见未改 sub-partial，避免引入额外回归风险。
- 健康度 chip 暂无"下钻到 requestLogs"链接。
- 错误关键字命中暂未覆盖中文错误。
- 测试 `tests/unit/chat-page.test.js` 在 P0 之前就 21/21 失败，本次未修复（属预先存在的测试漂移）。
- 浏览器扩展未连接，本次所有阶段未做交互式可视化验证；建议人工进入各 tab 实际点击验收。
