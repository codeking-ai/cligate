# 协议转换层下一阶段开发计划

## 1. 目的

本计划用于承接已完成的 Phase 3，进入下一阶段的“收口优化 + 可扩展功能化”工作。

原则：

- 先核对现有实现，避免重复开发
- 先消除共享层之外的重复协议逻辑
- 再把共享 metadata / capability 往 route 层接通
- 最后再进入新的 northbound 功能能力

---

## 2. 现状核对

### 2.1 已完成部分

以下能力已经有共享实现，不应重复开发：

- `requestEcho` 共享 helper
  - `src/translators/normalizers/request-echo.js`
- Anthropic → OpenAI Responses 主链路 translator
  - `src/translators/request/anthropic-to-openai-responses.js`
- OpenAI Responses → Anthropic 主链路 translator
  - `src/translators/response/openai-responses-to-anthropic.js`
- OpenAI Responses SSE → Anthropic SSE translator
  - `src/translators/response/openai-responses-sse-to-anthropic-sse.js`
- 最小 capability profile
  - `src/translators/registry.js`
- Anthropic tools canonical shape 与 OpenAI Responses 降级元数据
  - `src/translators/normalizers/tools.js`
- fixture corpus 与 fixture-driven translator tests
  - `tests/fixtures/translators/`
  - `tests/unit/translator-fixtures.test.js`

### 2.2 仍存在重复实现的部分

以下路径仍保留独立协议逻辑，和共享 normalizer / translator 重复：

- `src/providers/format-bridge.js`
  - 自己处理 system prompt
  - 自己处理 `tool_choice`
  - 自己把 Anthropic tools 映射为 OpenAI function tools
  - 没有消费共享 `tools.js`
- `src/kilo-format-converter.js`
  - 自己做 schema sanitize
  - 自己做 Anthropic tools / tool_choice 转换
  - 与共享 `schemas.js` / `tools.js` 有明显重复

### 2.3 Route 层现状

当前 route 层已经消费的共享 metadata：

- `requestEcho`
  - 已在 `src/providers/openai.js`
  - 已在 `src/direct-api.js`

当前 route 层还没有系统消费的共享 metadata：

- `__translatorMeta.unsupportedTools`
- `__translatorMeta.toolChoiceMeta`

也就是说：

- translator 已经能显式标出“hosted tool 被降级/忽略”
- 但 route/provider 还没有统一把这些元数据用于 northbound 拒绝、告警或日志

### 2.4 Capability registry 现状

当前 capability registry 已可用于 Gemini Anthropic bridge：

- `structuredToolCallMode`
- `disableThinkingBudgetAppsWithTools`

但以下能力差异仍未统一建模：

- `supportsHostedTools`
- `supportsInputFile`
- `supportsStructuredToolResult`
- `supportsInputImage`

这些差异仍部分散落在 provider / route 逻辑里。

---

## 3. 下一阶段目标

下一阶段分三步：

### A. 共享化收口

目标：

- 让旧的 chat bridge 路径复用 Phase 3 的共享 normalizer
- 消除重复 schema/tool/tool_choice 逻辑

### B. metadata 接通

目标：

- 让 route/provider 能消费 translator 显式输出的降级元数据
- 不再让 hosted tools 的降级仅停留在 translator 内部

### C. capability 扩展

目标：

- 把当前已出现的真实 provider 差异继续收敛为共享 capability
- 为下一步新增 hosted tools 原生支持做准备

---

## 4. 里程碑

## M1 旧 chat bridge 共享化

目标：

- `src/providers/format-bridge.js` 复用共享 tools normalizer
- `src/kilo-format-converter.js` 复用共享 schema/tool/tool_choice 逻辑

不重复开发：

- 不再新写一套 schema sanitize
- 不再新写一套 hosted/function tool 判断

建议实施步骤：

1. 为 OpenAI Chat 路径补一个共享 Anthropic tools → Chat tools 转换 helper
2. 让 `format-bridge.js` 接入共享 helper
3. 让 `kilo-format-converter.js` 接入共享 helper
4. 用现有 `tests/unit/kilo-format-converter.test.js` 做回归
5. 视需要补 `format-bridge` 单测

验收标准：

- `format-bridge.js` 不再手写 tool schema / tool_choice 映射
- `kilo-format-converter.js` 不再自带独立 schema sanitize
- 现有 chat-format 测试全部通过

## M2 route 层 metadata 接通

目标：

- 统一处理 `unsupportedTools` / `toolChoiceMeta`
- 把 translator 的显式降级信息变成 route/provider 可见行为

优先场景：

- `/v1/messages` 走 OpenAI Responses bridge
- `/responses` 走 Claude/兼容 provider 反向桥接

建议实施步骤：

1. 在 provider 或 route 层加一个统一 helper，读取 `__translatorMeta`
2. 至少先做日志与 request tracing
3. 评估是否要在严格模式下把 hosted-tool 降级从“静默容忍”升级为“显式拒绝”
4. 补 route 级测试

验收标准：

- hosted/builtin tools 的降级不再只能靠读 translator 代码才能发现
- route 日志或错误响应能解释降级原因

## M3 capability registry 扩展

目标：

- 把当前 provider 中已出现的真实差异，继续收敛到共享 capability

建议字段：

- `supportsHostedTools`
- `supportsInputFile`
- `supportsInputImage`
- `supportsStructuredToolResult`

建议实施步骤：

1. 盘点 OpenAI / Azure / Gemini / Vertex 的真实能力差异
2. 只加当前已经被至少两个链路使用的字段
3. 优先改 Gemini / Vertex / Responses 主链路
4. 保持 registry 最小，不为未来假设过度建模

验收标准：

- 至少两条以上链路复用新 capability 字段
- provider-specific if/else 数量减少

## M4 hosted tools 功能化支持

目标：

- 在共享层已稳定后，开始真正支持部分 hosted tools 的 northbound 语义

说明：

- 这一步是功能开发，不是收口
- 必须在 M1-M3 完成后再做

建议实施步骤：

1. 先选一类 hosted tool 做试点
2. 明确哪些 provider 可以 passthrough
3. 不支持的 provider 返回显式错误或降级说明
4. 补 fixture 与 route 回归

验收标准：

- 至少一种 hosted tool 在支持的链路上不是“被省略”，而是被真实保留

---

## 5. 实施顺序

建议按顺序推进：

1. `M1 旧 chat bridge 共享化`
2. `M2 route 层 metadata 接通`
3. `M3 capability registry 扩展`
4. `M4 hosted tools 功能化支持`

原因：

- `M1` 能先去掉重复实现，降低后续改动面
- `M2` 能让共享 metadata 真正产生外部可见价值
- `M3` 再做能力抽象时，基础会更稳定
- `M4` 属于新功能，应该建立在前面三步之上

---

## 6. 本轮实施范围

本轮只实施：

- `M1 旧 chat bridge 共享化`

本轮不做：

- route 行为改变
- hosted tools 的外部功能化支持
- 大规模 capability 字段扩张

---

## 7. 本轮实施文件

预计优先修改：

- `src/providers/format-bridge.js`
- `src/kilo-format-converter.js`
- 可能补充：
  - `src/translators/normalizers/tools.js`
  - `tests/unit/kilo-format-converter.test.js`
  - 新增 `tests/unit/format-bridge.test.js`

---

## 8. 完成定义

本轮完成时应满足：

- chat bridge 路径不再重复维护独立的 tool/schema/tool_choice 逻辑
- 共享 normalizer 至少被 `format-bridge` 和 `kilo-format-converter` 复用
- 相关单测通过
