# CliGate Assistant 需求定义（阶段 1）

## 1. 文档目的

本文档用于记录 CliGate Assistant 第一阶段的产品需求定义与已达成共识。

本阶段重点关注：

- 目标效果
- 使用场景
- 交互模式
- 可见数据范围
- 工具能力边界
- 自治边界与授权原则

本文档不进入具体代码架构拆分。

---

## 2. 阶段目标

CliGate Assistant 第一阶段的目标是：

在不破坏现有 direct runtime 体验的前提下，提供一个显式唤起的助手层，让用户能够通过 Web / Telegram / 飞书等入口，与一个具备调度、运维、状态查询、阻塞处理和结果汇总能力的 assistant 协作。

---

## 3. 核心使用模式

第一阶段产品必须同时支持两种模式。

### 3.1 Direct Runtime 模式

特征：

- 用户普通消息默认进入当前 Codex / Claude Code 会话
- 不做模糊自然语言拦截
- 保持低打扰、稳定、可预测

用户感知：

- “我直接发消息，就是在和 Codex / Claude Code 说话”

### 3.2 CliGate Assistant 模式

特征：

- 由用户显式唤起
- Assistant 接住需求并像助手一样协作
- 可查看状态、调度 executor、推进任务、总结结果

用户感知：

- “我唤起 assistant 后，就是在和 CliGate Assistant 说话”

---

## 4. Assistant 的产品定位

第一阶段的 CliGate Assistant 定位为：

**调度中枢 + 运维助手 + executor 协作层**

### 4.1 调度能力

Assistant 可以：

- 接收自然语言任务
- 决定是否复用已有 session
- 决定是否新开 Codex / Claude Code
- 选择合适 executor
- 将用户目标组织后委派出去

### 4.2 运维能力

Assistant 可以：

- 查看多个 runtime session 状态
- 查看 conversation 与 runtime 的绑定关系
- 继续 / 取消 / 重置 / 复用 session
- 查看审批、失败、问题与阻塞

### 4.3 非目标

第一阶段 Assistant 不以事务型能力为核心。

例如：

- 发邮件
- 调外部系统
- 直接执行外部自动化工作流

后续可扩展，但不是第一阶段重点。

---

## 5. 会话与记忆模型

### 5.1 全局身份与会话级 session

第一阶段采用以下模型：

- 全局只有一个 `CliGate Assistant` 身份
- 每个 Web / Telegram / 飞书 conversation 有独立 assistant session

每个 assistant session 只携带自己的上下文。

### 5.2 记忆分层

第一阶段确认采用分层记忆：

1. `global user`
2. `workspace / project`
3. `conversation`
4. `runtime session`

### 5.3 分层记忆用途

#### global user

用于长期偏好，例如：

- 默认中文回复
- 回复偏好简洁
- 默认偏好的 executor

#### workspace / project

用于项目级偏好，例如：

- 当前项目默认优先使用 Codex
- 项目工作目录
- 项目级行为偏好

#### conversation

用于当前对话内的任务与上下文，例如：

- 当前 conversation 绑定的 runtime
- 当前对话的临时要求
- 当前对话的最近任务摘要

#### runtime session

用于执行态状态，例如：

- 待审批
- 待问题回答
- 当前 turn 状态
- 临时授权

---

## 6. 唤起方式与交互模式

第一阶段确认采用双形态并存方案。

### 6.1 单次 assistant 调用

通过以下形式触发：

```text
/cligate <request>
```

特点：

- 一次请求触发一次 assistant 行为
- 适合快速查询、快速调度、快速运维

### 6.2 进入 assistant 模式

通过以下形式触发：

```text
/cligate
```

进入当前 conversation 的 assistant 模式后：

- 后续消息默认进入当前 assistant session
- Assistant 与用户持续多轮协作

### 6.3 退出 assistant 模式

通过以下形式退出：

```text
/runtime
```

退出后恢复 direct runtime 模式。

### 6.4 交互共识

第一阶段明确要求：

- 普通消息默认走 direct runtime
- 只有显式 `/cligate` 才进入 assistant
- 不允许再次回到模糊拦截模式

---

## 7. 默认可见数据范围

第一阶段确认采用：

**运维可见 + 摘要优先 + 按需下钻**

### 7.1 默认可见内容

Assistant 默认应先看到结构化摘要，而不是原始全文：

- 当前 conversation summary
- 当前绑定 runtime session summary
- 全局 session / task / approval / failure operational summary
- workspace / project summary

### 7.2 默认不直接注入的内容

以下内容不应默认全量注入 assistant 上下文：

- conversation 完整消息历史
- runtime 完整事件流
- 全量 delivery transcript
- 全量日志原文

### 7.3 按需下钻原则

当 assistant 需要更细信息时，应通过工具按需读取：

- 当前 conversation 消息片段或全文
- 某个 runtime session 的详细事件
- 某个 approval / failure / result 的原始内容

策略要求：

- 先概览
- 再下钻
- 最后回答

---

## 8. 第一阶段工具清单

第一阶段工具清单应保持克制，只围绕调度与运维展开。

### 8.1 会话观测工具

建议包含：

- `list_runtime_sessions`
- `get_runtime_session`
- `list_conversations`
- `get_conversation_context`

### 8.2 运行控制工具

建议包含：

- `start_runtime_task`
- `send_runtime_input`
- `cancel_runtime_session`
- `reset_conversation_binding`
- `resolve_runtime_approval`
- `answer_runtime_question`

### 8.3 调度工具

建议包含：

- `delegate_to_codex`
- `delegate_to_claude_code`
- `reuse_or_delegate`
- `summarize_runtime_result`

### 8.4 只读工作区观测工具

建议包含：

- `get_workspace_context`
- `list_project_artifacts`
- `search_project_memory`

### 8.5 第一阶段明确不做

- assistant 自己直接 shell
- assistant 自己直接文件写入
- assistant 自己直接浏览器自动化
- 发邮件
- 任意外部系统动作

这些能力可在后续阶段作为工具扩展。

---

## 9. 自主多步执行

第一阶段确认允许：

**assistant 作为受控 agent，自主进行有限多步执行。**

### 9.1 执行流程

推荐流程：

1. 用户发起 `/cligate` 请求
2. assistant 先回一条“正在执行”的确认消息
3. assistant 在后台自主完成多个步骤
4. assistant 返回最终结果

### 9.2 多步行动范围

Assistant 可以连续进行：

- 状态读取
- 信息下钻
- 会话判断
- executor 选择
- runtime 启动或继续
- 结果汇总

### 9.3 多步执行约束

第一阶段应受到以下约束：

- 步数预算
- 时间预算
- 权限边界
- 可观察与可回溯

### 9.4 建议引入独立对象

建议后续为每次 assistant 多步行为建立独立运行对象，例如：

- `assistant_run`

它用于记录：

- trigger message
- 使用工具链
- 关联 runtime session
- 当前状态
- 最终结果

---

## 10. 自治边界与授权原则

第一阶段确认采用如下原则：

**读自动、调度自动、副作用分级放开。**

### 10.1 默认自动允许

以下动作 assistant 可以自动执行：

- 查询与状态观察
- 查看 session / conversation / task / approval / failure
- 在用户明确委托目标内发起或继续 runtime
- 在已授权边界内推进任务

### 10.2 可放宽自动批准

用户希望 assistant 在部分执行动作上拥有更高自治能力。

因此第一阶段可放宽到：

- 在既有授权边界内
- 在已知 workspace / conversation 范围内
- 在低风险执行范围内

assistant 可以自主批准相关 runtime 操作。

### 10.3 仍需用户确认

以下情况仍建议保留确认：

- 高风险删除或覆盖
- 超出当前 workspace 的访问
- 外部发送类动作
- assistant 试图扩大权限边界
- 高风险命令执行

### 10.4 核心原则

第一阶段的正式授权原则为：

**assistant 可以在已授权边界内自主决策，但不能静默扩大边界。**

---

## 11. 第一阶段高频核心任务

第一阶段确认优先服务以下 5 类任务：

### 11.1 任务发起与委派

- 帮用户发起任务
- 选择 Codex / Claude Code
- 组织任务并下发 executor

### 11.2 任务跟踪与状态汇报

- 查看运行中任务
- 查看失败任务
- 查看等待审批 / 等待提问
- 汇报当前任务进展

### 11.3 会话运维与切换复用

- 继续已有 session
- 复用会话
- 重置绑定
- 切换管理对象

### 11.4 审批与阻塞处理

- 查看阻塞点
- 推进审批
- 推进提问回答
- 帮助恢复失败任务

### 11.5 结果汇总与交付

- 总结 executor 做了什么
- 输出结果摘要
- 给出下一步建议

---

## 12. 成功标准

第一阶段产品成功的标准如下。

### 12.1 普通消息稳定直达 runtime

用户直接发消息时：

- 默认进入当前 Codex / Claude Code 会话
- 不再出现误拦截

### 12.2 `/cligate` 唤起后像一个助手

唤起 assistant 后：

- 能自然对话
- 能回答问题
- 能查看状态
- 能调度 executor
- 能推进任务

### 12.3 能在移动端完成闭环

用户应能在 Telegram / 飞书等入口完成：

- 发起
- 跟踪
- 推进
- 获取结果

### 12.4 全局可见但不串上下文

Assistant 应：

- 具备全局运维可见性
- 但每个 assistant session 只携带自己的上下文

### 12.5 用户主观体验

用户感受上应满足：

- 直接发消息时，就是在和 Codex / Claude Code 对话
- 唤起 assistant 后，它像一个人一样协助自己，回答问题并执行任务

---

## 13. 当前共识总结

截至本文档形成时，CliGate Assistant 第一阶段的共识可以总结为：

- 产品同时支持 direct runtime 与 assistant collaboration 两种模式
- assistant 采用全局身份 + 多个会话级 session + 分层记忆
- assistant 默认采用运维可见、摘要优先、按需下钻
- assistant 第一阶段工具清单保持克制，以调度与运维为主
- assistant 允许受控的自主多步执行
- assistant 在已授权边界内可具备更高自治能力
- 第一阶段优先解决任务调度、会话运维、阻塞处理与结果交付
