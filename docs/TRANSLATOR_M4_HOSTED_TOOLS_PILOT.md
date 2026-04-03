# M4 Hosted Tools Pilot

## 1. 试点范围

本轮只做一类 hosted tool 试点：

- `web_search_*`

目标不是“一次性支持所有 hosted tools”，而是先把：

- 支持链路
- 不支持链路
- 降级/拒绝策略

定义清楚并落地。

---

## 2. 现状核对

### 2.1 已经可以原样保留 hosted tools 的链路

1. Anthropic 直连
   - `src/claude-api.js`
   - `sanitizeClaudeBody()` 会保留 hosted tool 的 `type/name/...`
   - 不会强塞 `input_schema`

2. Vertex Claude rawPredict
   - `src/providers/vertex-ai.js`
   - Claude 模型走 rawPredict，body 基本保持 Anthropic Messages 形态
   - 只做 `sanitizeClaudeBody()` / `cleanCacheControl()` 之类清洗
   - 因此 hosted tools 可以继续 passthrough

### 2.2 当前只会降级的链路

1. OpenAI Responses bridge
   - `src/translators/request/anthropic-to-openai-responses.js`
   - hosted tools 当前会被省略并写入 downgrade metadata

2. Azure OpenAI Responses bridge
   - `src/providers/azure-openai.js`
   - 复用 OpenAI Responses translator 路径
   - hosted tools 同样会被省略

3. Gemini bridge
   - `src/translators/request/anthropic-to-gemini.js`
   - 当前只支持 functionDeclarations

4. Vertex Gemini bridge
   - `src/providers/vertex-ai.js`
   - Gemini 模型路径复用 Anthropic → Gemini translator

### 2.3 当前问题

问题不在于“能不能静默省略”，而在于：

- 用户发了 hosted tools
- 某些 provider 根本不会真的执行
- 当前大多数非 Anthropic 链路只是降级，不是显式失败

这会造成 northbound 语义误导。

---

## 3. 试点策略

### 3.1 支持链路

允许 `web_search_*` passthrough：

- `anthropic` provider
- `vertex-ai` provider when target model is Claude / rawPredict

### 3.2 不支持链路

明确拒绝 `web_search_*`：

- `openai`
- `azure-openai`
- `gemini`
- `vertex-ai` when target model is Gemini

### 3.3 错误策略

对于不支持的链路：

- 不再只靠 translator metadata 静默降级
- provider `sendAnthropicRequest()` 直接返回 `400 invalid_request_error`
- 错误消息明确指出：
  - 请求包含 hosted tools
  - 当前 provider/bridge 不支持
  - 建议改用 Anthropic key 或 Vertex Claude

### 3.4 非目标范围

本轮不做：

- `code_execution` 等其他 hosted tools 的细分实现
- hosted tools 结果回传建模
- route 级自动 provider 重路由

---

## 4. 实施步骤

1. 共享 helper：
   - 增加 hosted tool 检测 helper
   - 增加 provider/model 级 hosted-tool 支持判断 helper

2. Provider 落地：
   - `OpenAIProvider.sendAnthropicRequest()` hosted tool → 明确 400
   - `AzureOpenAIProvider.sendAnthropicRequest()` hosted tool → 明确 400
   - `GeminiProvider.sendAnthropicRequest()` hosted tool → 明确 400
   - `VertexAIProvider.sendAnthropicRequest()`
     - Claude rawPredict 路径允许
     - Gemini 路径拒绝

3. 测试：
   - Anthropic sanitize 保留 hosted tools
   - OpenAI/Azure/Gemini 明确拒绝 hosted tools
   - Vertex Claude 允许 hosted tools
   - Vertex Gemini 拒绝 hosted tools

---

## 5. 完成定义

本轮完成时应满足：

- `web_search_*` 在支持链路上不被静默改写
- 不支持链路不再静默降级，而是显式报错
- 至少覆盖 OpenAI / Gemini / Vertex Claude / Vertex Gemini 四类行为
