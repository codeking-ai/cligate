# CliGate Assistant 产品愿景

## 1. 文档目的

本文档用于沉淀 CliGate Assistant 的产品愿景、定位、范围边界与长期方向。

这份文档不讨论具体代码实现和模块拆分，重点回答以下问题：

- CliGate Assistant 是什么
- 它为什么存在
- 它与 Codex / Claude Code 的关系是什么
- 它应该给用户带来什么体验
- 第一阶段的目标和非目标分别是什么

---

## 2. 一句话定位

CliGate 不是“把消息转给 Codex / Claude Code 的网关”，而是：

**站在用户与多个执行器之间的统一助手、调度中枢与运维入口。**

它负责：

- 理解用户需求
- 观察全局运行状态
- 决定下一步动作
- 调度 Codex / Claude Code 执行
- 管理会话、审批、阻塞与结果
- 将底层执行过程整理成用户可消费的回复

它不负责替代 Codex / Claude Code 的底层执行能力。

---

## 3. 核心愿景

CliGate Assistant 的长期目标是让用户在同一个产品中完成两类协作方式：

### 3.1 Direct Runtime

用户直接与当前 Codex / Claude Code 会话对话。

典型特征：

- 普通消息默认直接进入当前 runtime session
- 行为稳定、可预测、低打扰
- 不应被上层 assistant 误拦截

### 3.2 Assistant Collaboration

用户显式唤起 CliGate Assistant，由它像一个助手一样承接需求。

典型特征：

- 能理解自然语言目标
- 能查看全局状态与当前上下文
- 能决定复用哪个 session 或新开哪个 executor
- 能调度 Codex / Claude Code 执行任务
- 能处理审批、阻塞、失败与结果汇总
- 能像一个人一样与用户协作，而不是机械转发

---

## 4. 角色边界

## 4.1 CliGate Assistant 的职责

CliGate Assistant 的职责是：

- 调度
- 运维
- 观察
- 汇总
- 协作

它是一个上层 supervisor / operator agent，而不是底层 coder runtime。

## 4.2 Codex / Claude Code 的职责

Codex / Claude Code 仍然是执行器，负责：

- 代码修改
- 文件操作
- 命令执行
- 浏览器操作
- 具体任务的落地执行

CliGate Assistant 不应试图直接替代这些 executor 的执行职责。

## 4.3 两者之间的关系

正确关系是：

```text
用户
  -> CliGate Assistant
    -> 调度 Codex / Claude Code
      -> executor 执行任务
        -> CliGate Assistant 汇总并回复用户
```

也就是说：

- Assistant 负责理解、决策、调度、跟踪、汇总
- Executor 负责实际工作落地

---

## 5. 产品形态共识

基于当前阶段共识，CliGate Assistant 的产品形态应满足以下原则。

### 5.1 一个全局助手身份

系统中只有一个统一的 `CliGate Assistant` 产品身份。

它负责：

- 统一的助手入口
- 统一的全局观测能力
- 统一的调度与运维能力
- 统一的工具目录与策略

### 5.2 多个会话级 assistant session

每个 Web / Telegram / 飞书对话都有自己的 assistant session。

每个 assistant session 负责：

- 当前对话上下文
- 当前任务上下文
- 当前绑定的 runtime session
- 当前对话的临时偏好与记忆

这意味着：

- 全局只有一个 assistant 身份
- 但每个对话都有独立的 assistant 工作上下文

### 5.3 分层记忆

记忆不应只有全局或会话两个层级，而应采用分层作用域：

1. `global user`
2. `workspace / project`
3. `conversation`
4. `runtime session`

这使得用户偏好、项目偏好、当前对话偏好和执行态状态能够被正确隔离。

---

## 6. 第一阶段能力方向

CliGate Assistant 第一阶段的核心方向是：

### 6.1 调度型助手

能够：

- 接住用户需求
- 判断是复用已有 session 还是发起新任务
- 选择 Codex 或 Claude Code
- 将需求组织后交给 executor
- 追踪执行结果

### 6.2 运维型助手

能够：

- 查看多个 session 状态
- 管理当前 conversation 与 runtime 的绑定关系
- 继续、取消、重置、复用 session
- 发现阻塞、审批、失败和待答复问题

### 6.3 非事务型优先

第一阶段不以事务型能力为主。

例如：

- 发邮件
- 调外部系统
- 直接操作外部服务

这些不是第一阶段核心目标，可以作为后续工具扩展。

---

## 7. 第一阶段非目标

为了保持产品聚焦，以下内容明确不作为第一阶段主目标：

- 不让 assistant 直接替代 executor 执行代码与命令
- 不让普通消息重新进入模糊自然语言拦截
- 不做全自动、不可控的黑盒 agent
- 不优先做事务型工具生态
- 不要求 assistant 默认吞入所有完整日志和消息全文

---

## 8. 默认交互哲学

CliGate Assistant 必须遵循以下交互哲学：

### 8.1 默认低打扰

普通消息默认应继续当前 Codex / Claude Code 会话。

### 8.2 显式唤起

只有当用户显式唤起 assistant 时，它才应接管对话。

### 8.3 助手感而非命令感

唤起 assistant 后，用户应像和一个人协作一样与它交流，而不是像在操作底层命令系统。

### 8.4 全局可见，当前专注

assistant 应能看到全局运行状态，但每次对话时只应携带当前 assistant session 所需上下文。

---

## 9. 成功标准

以下结果出现时，可以认为 CliGate Assistant 的产品愿景开始成立：

### 9.1 模式清晰

用户能清晰感知：

- 普通消息是在与当前 runtime 对话
- 唤起 assistant 后是在与 CliGate Assistant 对话

### 9.2 助手真实可用

assistant 不只是展示信息，而是真的像一个助手一样：

- 回答问题
- 查看状态
- 调度 executor
- 推进任务
- 汇总结果

### 9.3 能完成手机端闭环

用户能够通过移动端完成：

- 发起任务
- 跟踪状态
- 推进执行
- 处理阻塞
- 获取结果

### 9.4 不串台

assistant 能看全局，但不会把别的 conversation 的上下文错误带进当前对话。

---

## 10. 长期方向

在第一阶段稳定后，CliGate Assistant 的长期方向可以扩展为：

- 更强的项目级记忆
- 更成熟的会话级与全局级偏好系统
- 更丰富的事务型工具
- 更完整的 assistant run 追踪与审计能力
- 更细粒度的风险分级与自动批准策略

但长期扩展必须建立在以下前提之上：

- direct runtime 路径始终稳定
- assistant 与 executor 的边界始终清晰
- assistant 的自治边界始终可控、可解释、可回溯

---

## 11. 当前结论

截至当前讨论阶段，CliGate Assistant 的正式愿景可总结为：

**CliGate Assistant 是一个全局身份的统一助手，它管理多个会话级 assistant session，使用分层记忆，在用户显式唤起时像真人助手一样承接需求，观察全局状态，调度 Codex / Claude Code 执行任务，并将运维、阻塞处理与结果汇总统一带回用户。**
