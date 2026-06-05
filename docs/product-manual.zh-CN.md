# 产品使用说明书

## 简介

CliGate 是一个本地 AI 控制平面，重点围绕两大重量级能力：

1. **Assistant**：一个常驻后端的私人助手 / 私人管家，能理解用户任务、记住上下文、使用工具、安排定时工作、接入渠道，并通过 MCP、Skills、桌面自动化、Shell / 文件工具或委派运行时自己执行事情。
2. **Model Proxy**：为 AI 编程工具和 API 兼容客户端提供统一本地 API 和模型路由层，背后接入本地凭证、provider 映射、日志、用量和成本控制。

Assistant 侧包括 Dashboard Chat、Assistant Tasks、任务记录、执行记录、记忆、策略、审批、澄清、渠道会话、定时任务、Skills、MCP 工具、Shell / 文件工具、可选桌面代理工具，以及在需要时委派给 Codex / Claude Code runtime session。

Model Proxy 侧包括 Claude Code、Codex CLI、Gemini CLI、OpenClaw 和 API 兼容客户端的协议转换；ChatGPT / Claude / Antigravity 账户池；API Key 路由；按应用绑定；模型映射；免费模型路由；本地运行时路由；请求日志；用量；定价；API 调试和一键工具配置。

CliGate 默认本地运行。最常见的使用路径是：启动服务，添加一个可用凭证，配置一个客户端，然后在仪表盘里验证行为。

## 快速开始

### 启动服务

可以用下面任意方式启动：

1. `npx cligate@latest start`
2. `cligate start`

默认仪表盘地址：

`http://localhost:8081`

### 推荐的首次配置顺序

1. 启动 CliGate
2. 打开仪表盘
3. 添加至少一个可用账户、API Key 或本地运行时
4. 打开 `Chat` 验证一个模型
5. 如果要用 Assistant，打开 `Chat` 或 `Assistant Tasks`，直接告诉私人助手你想完成什么
6. 如果要用 Model Proxy，打开 `Settings`，用一键配置接入你要代理的 CLI
7. 如果你还要接 Telegram / 飞书 / 钉钉，再去配置 `Channels`

## 仪表盘导航说明

当前仪表盘已经不是单一设置页，而是按工作区域组织。

### Workbench

#### Dashboard

`Dashboard` 用于快速确认系统是否可用，主要看：

- 已连接和可用账户数量
- 当前 plan 和 token 状态
- 快速跳转到账户、聊天、工具和日志
- 受支持 CLI 的一键配置入口

#### Chat

`Chat` 是常驻 Assistant 和 Model Proxy 的主要交互验证入口。

它支持两种模式：

- 模型对话模式，用于测试模型与路由
- 智能助手模式，用于让常驻 Assistant 规划、使用工具、执行任务或委派工作

常见控制项包括：

- `Chat Source`
- `Model`
- `System Prompt`
- `Product Assistant`
- 启用智能助手时的助手路由和运行时控制

`Product Assistant` 会优先参考本说明书来回答产品使用问题，但它不会悄悄改写全局路由。涉及配置写入的动作，仍然需要明确触发和确认。

#### Assistant Tasks

`Assistant Tasks` 是常驻 Assistant 所拥有工作的任务级运维视图，覆盖从仪表盘、渠道、定时任务或内部 handoff 发起的运行。

适合查看：

- 当前任务状态
- 待补充信息
- 待审批项
- 任务输出和执行历史
- 恢复和继续执行入口

#### Conversation Records

`Conversation Records` 用于查看已持久化的渠道会话和 runtime 执行记录。

适合排查：

- Telegram / 飞书 / 钉钉里一条会话到底发生了什么
- 当前对话关联了哪个 Assistant 任务或 runtime provider
- 某个任务是仍在执行、等待中，还是已经结束

### Assistant

#### Assistant Agent

`Assistant Agent` 是常驻 Assistant 的绑定和策略配置区域。

你可以在这里查看：

- assistant agent 是否启用
- 当前绑定了哪类凭证
- fallback 行为
- circuit breaker 状态
- 自主性、确认和执行边界

#### Skills

`Skills` 管理本地 assistant skill。

你可以在这里：

- 查看已发现的 skills
- 启用或禁用 skill
- 创建、导入、编辑或删除可写 skill

#### MCP

`MCP` 管理 Assistant 侧的 MCP server、tool 和 resource。

你可以在这里：

- 配置 MCP server
- 启用、重载或删除 server
- 查看 server 暴露的 tools 和 resources
- 通过本地控制平面调用 MCP tool 或读取 MCP resource

### CLI Tools

#### Tool Installer

`Tool Installer` 用于检查本地工具状态，并帮助安装或更新相关工具。

适合处理：

- Node.js 是否可用
- Claude Code / Codex CLI / Gemini CLI / OpenClaw 是否已安装
- 从仪表盘发起安装或升级

### Credentials

#### Accounts

`Accounts` 管理：

- ChatGPT 账户
- Claude 账户
- Antigravity 账户

支持的常见操作包括：

- 添加
- 导入
- 启用或禁用
- 刷新
- 切换
- 删除

#### API Keys

`API Keys` 管理不同 provider 的密钥，例如：

- OpenAI
- Anthropic
- Azure OpenAI
- Gemini
- Vertex AI
- MiniMax
- Moonshot
- ZhipuAI
- DeepSeek
- 通义千问（Qwen / DashScope）
- OpenRouter

启用后的 Key 可以参与系统路由，也可以直接在 `Chat` 中被选为来源。

#### Local Models

`Local Models` 用于管理本地运行时路由。

你可以在这里：

- 配置本地运行时地址
- 检查运行时健康状态
- 刷新已发现模型
- 将本地模型暴露给路由层

### Configuration

#### Channels

`Channels` 用于配置 Telegram、飞书和钉钉 provider。

典型设置包括：

- 轮询、Webhook 或长连接模式
- 本地桌面环境下飞书的 WebSocket 模式
- 默认 runtime provider
- 工作目录
- pairing / approval 行为

#### Scheduled Tasks

`Scheduled` 管理常驻 Assistant 的一次性或循环工作。

定时任务可以：

- 向指定会话发送提醒
- 到点唤起 Assistant 执行一段指令
- 可选绑定工作目录
- 每次运行使用 fresh 上下文，或跨运行共享上下文

#### Routing

`Routing` 控制请求如何被实际解析。

重要概念包括：

- `Routing Priority`：账户池优先还是 API Key 优先
- `Routing Mode`：自动路由还是按应用绑定
- `App Assignments`：把某个客户端固定绑定到某个凭证或本地运行时
- `Free Models`：是否启用免费模型 fallback 路径
- `Model Mapping`：将请求模型名映射到实际上游模型

#### Settings

`Settings` 负责受支持工具的一键配置和通用服务端选项。

最常用的操作是：

- 把 Claude Code 配到代理模式
- 把 Codex CLI 配到代理模式
- 把 Gemini CLI 配到代理模式
- 把 OpenClaw 配到代理模式
- 在启用桌面自动化时查看或管理 Desktop Agent 设置

### Monitoring

#### Usage

`Usage` 展示账户、provider、模型维度的聚合用量。

适合查看：

- 总览指标
- 日趋势 / 月趋势
- provider 维度的成本情况

#### Pricing

`Pricing` 是手动定价表与覆盖面板。

你可以在这里查看或调整：

- 模型定价项
- provider 定价假设
- 成本计算时使用的手动覆盖值

#### Request Logs

`Request Logs` 是请求与响应的结构化历史视图。

适合查看：

- 某一天的请求记录
- 某个 provider 的失败情况
- 经过筛选的请求历史

#### API Explorer

`API Explorer` 用于直接测试本地接口。

适合：

- 协议验证
- 路由调试
- 格式化查看请求和响应

#### Logs

`Logs` 更接近服务端实时输出。

当 `Request Logs` 不足以解释问题时，可以到这里看更原始的运维上下文。

### Resources

#### Manual

`Manual` 是产品内轻量说明页，对应 `/manual/`。

它适合第一次打开产品时快速了解核心路径。完整真相源仍然是 `docs/` 下的说明文档。

#### Resources

`Resources` 是免费 / 试用 LLM provider 的资源目录页，对应 `/resources/`。

它是只读目录，本身不会自动改变系统路由。

## 凭证与最低可用条件

CliGate 至少需要一条可用的上游路径。

通常意味着至少具备下列之一：

1. 一个可用的 ChatGPT 账户
2. 一个可用的 Claude 账户
3. 一个可用的 Antigravity 账户
4. 一个可用的 API Key
5. 一个能够承接你请求的本地运行时

如果这些都没有，请求就无法成功路由。

## Assistant

### 什么时候使用 Assistant

当你想做下面这些事情时，使用 Assistant 侧能力：

- 让一个常驻私人助手执行真实任务
- 在追问、审批、澄清和渠道之间保持任务上下文
- 查看任务记录、执行记录和 transcript
- 在受控本地工作流里使用 Skills、MCP 工具、Shell / 文件工具或桌面自动化
- 创建一次性或循环的定时 Assistant 工作
- 通过渠道会话承接移动端或团队协作流程
- 只有当编程任务适合交给外部编码 agent 时，才委派给 Codex / Claude Code
- 通过 `Product Assistant` 提问产品使用问题

### Product Assistant 会做什么

开启 `Product Assistant` 后，CliGate 会优先参考本说明书，回答这类产品问题：

- Claude Code 怎么配置
- API Key 怎么添加
- Routing Mode 是什么意思
- 怎么关闭某个工具的代理模式

Product Assistant 只是更大 Assistant 能力中的一种模式。更完整的 Assistant 是任务导向的：它可以创建任务、使用工具、记住上下文、追问缺失信息、等待审批、恢复执行，并通过仪表盘或渠道交付结果。

### Product Assistant 不会做什么

- 不会因为你只是提问就自动改配置
- 不会静默改写路由或账户设置
- 不会替代你正常聊天时选择的实际上游来源

## Model Proxy

### 什么时候使用 Model Proxy

当你想做下面这些事情时，使用 Model Proxy 侧能力：

- 让 Claude Code、Codex CLI、Gemini CLI、OpenClaw 或 API 兼容客户端走本地路由
- 统一管理账户、API Key 和本地运行时
- 把不同应用固定绑定到不同凭证
- 将请求侧模型名映射到实际上游模型名
- 查看请求日志、用量、定价和 provider 失败情况

### Model Proxy 会做什么

Model Proxy 接收客户端原本就会发送的协议格式，然后解析这次请求应该发到哪里。

常见代理面包括：

- Claude Code 和 Anthropic 兼容客户端使用的 Anthropic Messages
- OpenAI Chat Completions
- OpenAI Responses 和 Codex 兼容端点
- Gemini 兼容路由

客户端不需要拥有你的 provider 策略。CliGate 会在本地处理路由、凭证、fallback、日志和成本可见性。

## 工具配置说明

### Claude Code

在 `Settings` 中使用一键配置，把 Claude Code 指向本地代理。

常见代理值包括：

- `ANTHROPIC_BASE_URL=http://localhost:8081`
- `ANTHROPIC_API_KEY=sk-ant-claude-code-proxy`

可通过下面接口查看当前状态：

- `GET /claude/config`

### Codex CLI

在 `Settings` 中使用一键配置接入 Codex CLI。

典型配置会指向本地的：

- `chatgpt_base_url`
- `openai_base_url`

可通过下面接口查看当前状态：

- `GET /codex/config`

### Gemini CLI

在 `Settings` 中使用一键配置，将 Gemini CLI 调整到本地代理兼容模式。

可通过下面接口查看当前状态：

- `GET /gemini-cli/config`

### OpenClaw

在 `Settings` 中使用一键配置，将 OpenClaw 接到 CliGate。

可通过下面接口查看当前状态：

- `GET /openclaw/config`

## Channels 与 Runtime Session

### 支持的渠道工作流

CliGate 目前支持 Telegram、飞书和钉钉渠道工作流，对应 `Channels` 配置区域和相关 API 路由。

### Runtime session 的连续性

一旦某条 Web 或渠道对话绑定到 runtime session，后续消息就可以继续沿用同一运行时上下文，直到用户主动重置或解绑。

这对下面这些场景很重要：

- 持续推进一个任务而不用重复上下文
- 连续处理审批请求
- 回答运行时问题而不丢失当前任务

### 常见渠道命令

常用命令包括：

- `/cx <任务>`：启动新的 Codex 会话
- `/cc <任务>`：启动新的 Claude Code 会话
- `/new`：解绑当前 session，让下一条消息重新开始

更详细的渠道接入说明请看仓库中的渠道相关文档。

## 路由核心概念

### Routing Priority

当账户池和 API Key 池都可用时，`Routing Priority` 决定先尝试哪一类。

### Routing Mode

当前支持两种模式：

1. `automatic`
2. `app-assigned`

如果你希望保持系统默认路由逻辑，使用 `automatic`。

如果你希望不同客户端固定走不同凭证或本地运行时，使用 `app-assigned`。

### App Assignments

例如：

- Codex 永远走某个 ChatGPT 账户
- Claude Code 永远走某个 Claude 账户
- Gemini CLI 永远走某个 API Key
- OpenClaw 永远走某个本地运行时或 provider key

### Model Mapping

模型映射允许“请求侧模型名”和“实际调用上游模型名”不一致。

适合：

- 客户端要求某个模型 ID，但你希望实际落到别的上游模型
- 你希望本地暴露稳定模型名，而上游实现可以切换

### Free Models

启用免费模型路由后，受支持的请求可以走配置好的免费上游路径。

## API 与运维面

常见接口包括：

- `POST /v1/messages`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /backend-api/codex/responses`
- `POST /v1beta/models/*`
- `GET /api/agent-runtimes/providers`
- `GET /api/agent-channels/conversations`
- `GET /api/assistant/tasks`
- `GET /api/assistant/mcp/servers`
- `GET /api/assistant/skills`
- `GET /api/desktop-agent/status`
- `GET /api/resources`
- `GET /health`

排查路由问题时，建议一起使用 `API Explorer`、`Request Logs` 和 `Logs`。

## 常见使用场景

### 我只想验证模型是否可用

1. 添加账户、API Key 或本地运行时
2. 打开 `Chat`
3. 选择来源
4. 输入模型名
5. 发一条简单消息

### 我想让 Assistant 执行一个任务

1. 添加能支撑该任务的凭证、本地运行时或工具路径
2. 打开 `Chat` 或 `Assistant Tasks`
3. 告诉 Assistant 你想要的结果
4. 如果任务需要项目文件，设置工作目录
5. 在仪表盘里观察审批、澄清、工具调用、runtime 委派和结果

### 我想让 Claude Code 走本地代理

1. 确保 CliGate 正在运行
2. 打开 `Settings`
3. 执行 Claude Code 一键配置
4. 如有确认步骤则完成确认
5. 启动 Claude Code

### 我想让每个工具走不同路由

1. 打开 `Routing`
2. 把 `Routing Mode` 设为 `app-assigned`
3. 配置 `App Assignments`
4. 在 `Chat`、`API Explorer` 或真实客户端里验证结果

### 我想从移动端或渠道里使用 runtime

1. 先确保核心路由在仪表盘中已验证通过
2. 打开 `Channels`
3. 配置 Telegram、飞书或钉钉
4. 设置默认 runtime provider 和工作目录
5. 在 `Conversation Records` 中查看执行过程

## 故障排查

### 仪表盘打不开

先检查：

1. 服务是否已启动
2. 本地端口是否可访问
3. 地址是否为 `http://localhost:8081`

### Chat 请求失败

先检查：

1. 是否存在至少一个有效上游凭证或本地运行时
2. 当前选择的来源是否仍处于启用状态
3. 当前模型是否被实际生效的上游 provider 接受

### 某个 CLI 工具没有走 CliGate

先检查：

1. 是否已经在 `Settings` 中完成一键配置
2. 对应工具配置接口是否显示为代理模式
3. CliGate 是否运行在预期的本地端口

### Product Assistant 回答不完整

Product Assistant 依据的是产品手册上下文。如果这里没有明确写到某件事，预期行为是明确表示“手册未提供答案”，而不是自行推断实现细节。

## 重要说明

1. Product Assistant 是说明入口，不是隐式执行入口。
2. Assistant 任务工作流和普通 Model Proxy 补全不是同一种路径。
3. 当 UI 或产品流程变化时，README、手册、截图和 Dashboard 文案需要一起更新。
