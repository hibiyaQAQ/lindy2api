# Lindy 工作流配置

这份说明按“最容易先跑通”的方式来写。先做一个固定模型的纯文本工作流，确认链路通了，再考虑多 webhook 和复杂 agent。

## 推荐起步方案

先用：

- `Webhook Received`
- `LLM Call`
- `Send POST Request to Callback`

不要一开始就上 `AI Agent`。原因很简单：

- `LLM Call` 更接近标准文本 API
- 行为更可控
- 更容易对齐 OpenAI / Anthropic 的单轮返回
- 排查问题时变量更少

## 工作流目标

桥接层会发一个 JSON 给 Lindy webhook，大概长这样：

```json
{
  "jobId": "uuid",
  "callbackUrl": "https://bridge.example.com/__lindy/callback/uuid?token=xxx",
  "apiFlavor": "openai",
  "requestedModel": "default",
  "system": "你是一个严谨的助手。",
  "messages": [
    { "role": "user", "text": "你好" },
    { "role": "assistant", "text": "你好，请说。" }
  ],
  "prompt": "桥接层整理好的完整对话文本（不含 system）",
  "lastUserMessage": "最后一条用户消息",
  "temperature": 0.2,
  "maxTokens": 512,
  "metadata": { "provider": "openai" }
}
```

你的 Lindy 任务就是：

1. 取出这里面的 `system` 和 `prompt`
2. 用 `LLM Call` 生成回复
3. 把回复 POST 回 `callbackUrl`

## 第 1 步：创建 webhook 工作流

1. 在 Lindy 里新建一个 workflow。
2. 选择 `Webhook Received` 作为 trigger。
3. 给 webhook 起一个清楚的名字，比如 `bridge-default`。
4. 生成 Secret，并保存下来。
5. 复制 webhook URL。
6. `Follow-up Behavior` 先选 `Create new task`。

原因：

- 标准 API 请求通常相互独立。
- 先避免不同请求在 Lindy 内部串上下文。

## 第 2 步：确认 webhook 输入变量

文档明确给出的入口变量是：

- `{{webhook_received.request.body}}`
- `{{webhook_received.request.headers}}`
- `{{webhook_received.request.query}}`

文档没有逐项写出所有子字段的最终点路径，所以这里有一条务实规则：

- 不要手写猜变量名。
- 在 Lindy 编辑器里通过变量选择器点选 `request.body` 下面的字段。

你应该能在 UI 里看到与下面这些字段等价的内容：

- `system`
- `prompt`
- `lastUserMessage`
- `callbackUrl`
- `requestedModel`

## 第 3 步：添加 LLM Call

在 webhook 后面加一个 `LLM Call`。

### 建议配置

#### Model Provider

先在这个工作流里固定一个模型。

原因：

- 文档明确说 `LLM Call` 可以选模型，但没有明确说明你现在这套桥接模式下最稳妥的“动态按入参切模型”配置方式。
- 所以当前项目默认推荐：一个 webhook 对应一个固定模型。
- 如果你需要多个“模型名”，就建多个 Lindy webhook，再用 `LINDY_ROUTES` 做路由。

#### System Prompt

这里建议直接使用 webhook 请求体里的 `system` 字段；如果为空，就给一个兜底提示词。

可参考逻辑：

```text
如果请求里有 system，就使用它。
如果没有，就使用：
你是一个通过 API 返回纯文本结果的助手。请直接返回最终答案，不要输出多余前缀。
```

因为 Lindy 编辑器具体支持的条件写法可能随节点不同而不同，最稳的做法通常是：

- 先直接绑定 `system`
- 如果经常为空，再额外加一个条件节点做分支

#### User Prompt

直接使用 webhook 请求里的 `prompt`。

桥接层已经把完整历史整理成了一段文本，而且默认不再重复包含 `system`，所以这里不需要你再自己拼消息。

#### Temperature / Max Output Tokens

第一版建议直接在 Lindy 里填固定值，例如：

- `Temperature = 0.2`
- `Max Output Tokens = 1024`

原因：

- 文档虽然说明这些字段存在，但没有在这条工作流范式下清楚展示“把 webhook 数值变量直接映射进这些控件”的细节。
- 先固定值，排除变量映射噪音。

跑通后再考虑把它们也做成动态。

## 第 4 步：添加回调动作

在 `LLM Call` 后面添加 `Send POST Request to Callback`。

如果你的账号里根本找不到这个 action / skill，就改用 `HTTP Request`，效果上也能完成回调。

### callbackUrl

使用 webhook 请求体里的 `callbackUrl`。

如果你改用 `HTTP Request`，推荐优先直接使用 `callbackUrl`，并把请求体作为纯文本发回。

这样最稳，因为模型输出里常见的换行、制表符或其他控制字符，不会再被硬塞进 JSON 字符串里。

如果你看到类似下面的报错：

```text
The request body is not valid JSON: Bad control character in string literal in JSON ...
```

通常就是最后一步把 LLM 输出直接拼进 JSON body 了。

### Body

推荐直接把 `LLM Call` 的最终文本输出原样作为请求体发回，不要再手写 JSON 包装。

文档只明确说 `LLM Call` 的输出是 `AI Response`，但没有在导出文本里把最终模板变量名固定写死，所以这里建议：

- 不要凭空手写变量名
- 直接在动作里点击 `LLM Call` 的输出变量

### 如果只能用 `HTTP Request` 回调

桥接层同样支持下面这种固定 URL 回调方式。

Lindy webhook 请求体里会多给你两个字段：

```json
{
  "jobId": "uuid",
  "requestId": "uuid",
  "callbackUrl": "https://your-bridge.example.com/__lindy/callback/uuid?token=xxx",
  "callbackRequestUrl": "https://your-bridge.example.com/__lindy/callback?token=xxx"
}
```

最稳的 `HTTP Request` 配置是：

- `Method`：`POST`
- `URL`：`callbackUrl`
- `Content-Type`：`text/plain`
- `Body`：直接放 `LLM Call` 的最终文本输出

因为 `callbackUrl` 自身已经带了 `jobId`，桥接层会把整个请求体当成最终 `content`。

如果你的 UI 限制必须发 `application/json`，再退回下面这个方案：

- `Method`：`POST`
- `URL`：`callbackRequestUrl`
- `Content-Type`：`application/json`
- `Body`：

```json
{
  "jobId": "原请求的 jobId",
  "content": "最终模型回答"
}
```

只有在你确认变量会被正确 JSON 转义时，才建议用这个方案。

如果你只能使用固定的 `callbackRequestUrl`，但又想保留 `text/plain`，也可以把 `jobId` 放到查询参数 `?jobId=...`，或者放到请求头 `x-lindy-job-id`。

### 如果拿不到 `body.system` / `body.prompt`

桥接层现在额外提供了一个辅助 endpoint：

```text
POST /__lindy/prepare?token=你的 LINDY_CALLBACK_TOKEN
```

它的作用是把 Lindy 手里的原始 webhook body 再整理一遍，返回更容易被后续节点消费的字段：

```json
{
  "system": "字符串形式的 system",
  "prompt": "字符串形式的 prompt（不含 system）",
  "lastUserMessage": "最后一条用户消息",
  "jobId": "uuid",
  "callbackUrl": "https://your-bridge.example.com/__lindy/callback/uuid?token=xxx",
  "callbackRequestUrl": "https://your-bridge.example.com/__lindy/callback?token=xxx",
  "bodyText": "{ ...原始 body 的字符串化结果... }"
}
```

如果你的 Lindy 只能把 HTTP 响应当成一整个 `output`，不能继续按 JSON 字段展开，就不要让它拿整份 JSON，而是直接请求单个字段：

```text
POST /__lindy/prepare?token=你的 LINDY_CALLBACK_TOKEN&field=system
POST /__lindy/prepare?token=你的 LINDY_CALLBACK_TOKEN&field=prompt
POST /__lindy/prepare?token=你的 LINDY_CALLBACK_TOKEN&field=jobId
POST /__lindy/prepare?token=你的 LINDY_CALLBACK_TOKEN&field=callbackUrl
```

这些请求会直接返回纯文本，所以每个 HTTP Request 节点的整个 output，就正好是你要的值。

推荐工作流：

```text
Webhook Received
-> HTTP Request（POST 到 /__lindy/prepare）
-> LLM Call（直接绑定 prepare 返回的 system / prompt）
-> HTTP Request（回调 callbackUrl 或 callbackRequestUrl）
```

`/__lindy/prepare` 支持三种输入：

- 直接把整个 webhook body 作为 `application/json` 发过去
- 用 JSON 包一层，例如 `{ "body": <原始 body> }`
- 如果你只能拿到原始 JSON 字符串，就用 `text/plain` 发过去

如果原始 body 里已经有 `prompt` / `system`，它会直接返回；如果只有 `messages`，它也会自动重建 prompt。

默认建议你在 `LLM Call` 里使用：

- `System Prompt` -> `system`
- `User Prompt` -> `prompt`

如果你当前 UI 不能消费 HTTP 返回的 JSON 字段，推荐直接拆成多个节点：

```text
Webhook Received
-> HTTP Request（field=system）
-> HTTP Request（field=prompt）
-> HTTP Request（field=jobId）
-> LLM Call（System Prompt 用 system 节点输出，User Prompt 用 prompt 节点输出）
-> HTTP Request（固定 callback URL，header 里带 x-lindy-job-id，body 放最终文本）
```

常用 `field` 有这些：

- `system`
- `prompt`
- `lastUserMessage`
- `jobId`
- `requestId`
- `callbackUrl`
- `callbackRequestUrl`
- `requestedModel`
- `bodyText`

## 第 5 步：推荐回调格式

如果你能在 Lindy 里拿到更多结构化字段，建议回调成这样：

```json
{
  "content": "模型最终文本回复",
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  },
  "meta": {
    "requestedModel": "default",
    "provider": "openai"
  }
}
```

如果拿不到 token 用量，就只回：

```json
{
  "content": "模型最终文本回复"
}
```

桥接层接受下面任一文本字段：

- `content`
- `text`
- `response`
- `assistant_response`

但建议统一用 `content`。

## 第 6 步：本地联调顺序

按这个顺序最稳：

1. 启动桥接层。
2. 访问 `GET /healthz` 确认服务正常。
3. 用 `curl` 直接打桥接层的 `/v1/chat/completions`。
4. 观察 Lindy 任务是否被触发。
5. 在 Lindy 任务详情里确认 `Webhook Received` 是否收到了 `system` / `prompt` / `callbackUrl`。
6. 确认 `Send POST Request to Callback` 成功。

## 常见错误

### 收到 webhook，但桥接层一直超时

通常说明：

- `callbackUrl` 没有真正被发回去
- Lindy 回调动作失败
- 回调 URL 对公网不可达
- 反向代理把 `POST /__lindy/callback/...` 挡住了

### Lindy 收到数据，但模型输出为空

优先检查：

- `LLM Call` 的 `User Prompt` 是否真的绑定到了 `prompt`
- `system` 是否被错误写死或为空
- `LLM Call` 输出变量是否选错

### OpenAI 客户端报 502

这说明桥接层收到了请求，但 Lindy 上游或回调有问题。先看：

1. 桥接层日志
2. Lindy 任务执行记录
3. 回调动作响应状态

## 多模型工作流

如果你想让不同 `model` 名映射到不同 Lindy 模型，推荐不要在一个工作流里动态切模型，而是拆成多个 webhook：

- `default` -> 一个平衡模型
- `gpt-4.1-mini` -> 一个偏便宜模型
- `claude-3-7-sonnet-latest` -> 一个偏强模型

然后在桥接层的 `LINDY_ROUTES` 里做映射。

这样更稳定，也更容易单独调试每个模型链路。

## 进阶方案：AI Agent

等纯文本链路跑通后，你再考虑把 `LLM Call` 换成 `AI Agent`。

适合换成 `AI Agent` 的场景：

- 你希望 Lindy 在内部自行调用其他工具
- 你要让它做多步处理
- 你不只想拿一段文本，而是想做复杂自动化

但要接受两个结果：

- 行为会更像 agent，而不是传统 completion
- 与标准 OpenAI / Anthropic 单次文本 API 的一致性会下降
