# lindy2api

把 `Lindy` 的网页/工作流能力，包装成你本地可调用的标准接口。

这个项目的目标不是“破解 Lindy 官方网页聊天”，而是利用 `Lindy` 官方文档里公开的工作流能力：

- `Webhook Received`
- `LLM Call`
- `Send POST Request to Callback`

把它们拼成一条链路，让你能像调用 `OpenAI` 或 `Anthropic` API 一样去调用 Lindy。

## 这份 README 适合谁

如果你满足下面任一情况，这份文档就是为你写的：

- 你买了 `Lindy` 会员，但只会在网页上聊天，不知道怎么程序化调用
- 你完全不懂 `webhook`、`callback`、`公网回调`
- 你想让现有项目尽量少改代码，就接上 Lindy
- 你希望先跑通“文本问答”，以后再考虑更复杂的自动化

这份教程按“默认你什么都不懂”的方式来写。

## 先说结论

`Lindy` 目前没有在文档里公开一个现成的“OpenAI 兼容 API 地址”给你直接填进 SDK。  
但是它公开了足够的能力，所以我们可以自己做一层桥接：

1. 你的代码先调用本项目。
2. 本项目把请求转成对 `Lindy webhook` 的 HTTP 请求。
3. `Lindy` 工作流收到请求后，用 `LLM Call` 生成回答。
4. `Lindy` 再把结果回调给本项目。
5. 本项目把结果重新包装成标准 API 响应，返回给你的代码。

也就是说：

- 你的业务代码不直接连 `Lindy`
- 你的业务代码连的是这个桥接服务
- 桥接服务再去调用 `Lindy`

## 你最后会得到什么

本项目启动后，会提供这些接口：

- `POST /v1/chat/completions`
- `POST /v1/messages`
- `GET /v1/models`
- `GET /healthz`

它们分别兼容：

- `OpenAI Chat Completions`
- `Anthropic Messages`

所以你很多现有代码只需要改一个 `baseURL`，就能先接上 Lindy。

## 先理解几个最重要的概念

如果你完全不懂，这一节最关键。

### 1. 什么是 webhook

你可以把 `webhook` 理解成：

“系统 A 事先给系统 B 一个 URL，以后系统 B 只要访问这个 URL，就能触发系统 A 做事。”

更接地气一点：

- 普通网页像一个“网站页面”
- webhook 更像一个“门铃”
- 别的系统按这个门铃，你预先配置好的流程就会被唤醒

在 `Lindy` 里：

- `Webhook Received` 就是一个触发器
- 它会生成一个 URL
- 任何程序只要向这个 URL 发 HTTP 请求，就能唤醒 Lindy 工作流

### 2. 什么是 callback

`callback` 可以理解成“回电话”。

比如：

1. 你先打电话给 Lindy，说“帮我处理这段文本”
2. 你顺手告诉它：“处理完后请打这个号码回我”
3. Lindy 处理完以后，再按你给的号码回电话

在技术上：

- 你第一次打出去的请求，是你调用 Lindy webhook
- 你留给 Lindy 的“回电话地址”，就是 `callbackUrl`
- Lindy 处理完以后，主动再请求你给它的这个 `callbackUrl`

### 3. 什么是 `PUBLIC_BASE_URL`

这个变量非常重要。

它表示：

“你的桥接服务在公网中的可访问地址”

比如：

```text
https://bridge.example.com
```

为什么一定要公网地址？

因为 `Lindy` 在云端，不在你的电脑里。  
它处理完结果以后，要主动回调你的桥接服务。  
如果你给它的是：

```text
http://127.0.0.1:8787
```

那只能你自己电脑访问到，`Lindy` 根本访问不到。

所以：

- `Lindy webhook URL` 是 Lindy 提供给你的入口地址
- `PUBLIC_BASE_URL` 是你提供给 Lindy 的回调地址前缀

### 4. 这条链路到底是谁调用谁

很多人第一次最容易绕晕在这里。

正确方向是：

```text
你的程序
  -> 调这个项目
  -> 这个项目调用 Lindy webhook
  -> Lindy 处理
  -> Lindy 回调这个项目
  -> 这个项目把结果返回给你的程序
```

不是：

```text
你的程序 -> 直接调 Lindy 网页聊天
```

也不是：

```text
Lindy 主动提供一个现成的 OpenAI 兼容地址给你
```

## 整体架构图

```text
你的代码 / SDK
        |
        |  OpenAI / Anthropic 风格请求
        v
  本项目桥接服务
        |
        |  POST 到 Lindy webhook
        v
      Lindy
  Webhook Received
        |
        v
    LLM Call
        |
        |  POST 到 callbackUrl
        v
  本项目桥接服务
        |
        |  标准 API 响应
        v
你的代码 / SDK
```

## 这个项目当前支持什么，不支持什么

### 支持

- 文本对话
- OpenAI 风格 `chat.completions`
- Anthropic 风格 `messages`
- `stream=true` 的伪流式兼容（等待完整结果后一次性按 SSE 格式返回）
- 单 webhook 固定模型
- 多 webhook 按 `model` 名路由

### 不支持

- 工具调用 / function calling
- 图片、音频、多模态输入
- 严格还原官方 token 计量
- 直接接入 Lindy 网页聊天内部会话接口

所以你应该把它理解成：

“一个最小可用的文本 API 兼容层”

## 项目目录

- [server.mjs](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/server.mjs)
- [.env.example](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/.env.example)
- [Dockerfile](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/Dockerfile)
- [examples/openai-sdk.mjs](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/examples/openai-sdk.mjs)
- [examples/anthropic-sdk.mjs](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/examples/anthropic-sdk.mjs)
- [scripts/smoke-test.mjs](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/scripts/smoke-test.mjs)
- [docs/lindy-workflow-setup.md](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/docs/lindy-workflow-setup.md)
- [docs/deploy.md](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/docs/deploy.md)
- [docs/sdk-examples.md](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/docs/sdk-examples.md)

## 使用前准备

你至少需要这些东西：

### 1. 一个 Lindy 账号

并且这个账号需要能创建自定义 workflow。

你要在 Lindy 后台能看到类似这些能力：

- 新建 workflow
- `Webhook Received`
- `LLM Call`
- `Send POST Request to Callback`

### 2. Node.js

建议 Node 18 以上。你当前机器已经有 Node。

### 3. 一个公网可访问地址

这是最容易忽略的一点。

你有两种常见选择：

#### 方案 A：你本来就有服务器或域名

那最简单，直接把这个项目部署上去。

#### 方案 B：你在本机开发

那你需要一种“把本机 8787 端口暴露到公网”的办法。

你可以用任意你熟悉的方式：

- 云服务器反向代理
- 隧道工具
- 内网穿透工具

核心要求只有一个：

```text
Lindy 能从公网访问到你的桥接服务
```

## 一条最推荐的上手路径

如果你想最稳地跑通，按这个顺序：

1. 先在本地把桥接服务跑起来
2. 再准备一个公网地址
3. 再去 Lindy 后台建 workflow
4. 最后把 Lindy 的 webhook URL 和 secret 填回 `.env`
5. 用 `curl` 或 SDK 试打

下面按这个顺序讲。

---

## 第一步：本地启动桥接服务

### 1. 准备环境变量

先复制一份 `.env.example`，命名为 `.env`。

最少需要这些变量：

```env
PORT=8787
BRIDGE_CONFIG_PATH=bridge.config.json
PUBLIC_BASE_URL=https://your-public-bridge.example.com
LINDY_WEBHOOK_URL=https://public.lindy.ai/api/v1/webhooks/your-webhook-id
LINDY_WEBHOOK_SECRET=your-lindy-webhook-secret
```

建议再加这几个：

```env
BRIDGE_API_KEY=your-local-api-key
ADMIN_TOKEN=your-admin-token
LINDY_CALLBACK_TOKEN=your-callback-token
REQUEST_TIMEOUT_MS=120000
```

### 2. 每个变量是什么意思

#### `PORT`

桥接服务本机监听的端口。

默认：

```env
PORT=8787
```

#### `PUBLIC_BASE_URL`

这是最重要的变量之一。

表示：

“Lindy 回调时，应该访问的你的公网地址前缀”

例如：

```env
PUBLIC_BASE_URL=https://bridge.example.com
```

如果你本机跑服务，但还没做公网映射，这里先不要填 `127.0.0.1`，那样 Lindy 访问不到。

#### `BRIDGE_CONFIG_PATH`

可选。

用于指定可视化管理页面保存配置文件的位置。

默认：

```env
BRIDGE_CONFIG_PATH=bridge.config.json
```

#### `LINDY_WEBHOOK_URL`

这是你在 Lindy 里创建 `Webhook Received` 之后，Lindy 给你的那个地址。

格式通常像这样：

```text
https://public.lindy.ai/api/v1/webhooks/xxxxxxxx
```

#### `LINDY_WEBHOOK_SECRET`

这是你在 Lindy webhook 里生成的 Bearer Secret。

桥接服务会带着它去调用 Lindy。

#### `BRIDGE_API_KEY`

这是你给“桥接服务自己”设置的一层保护。

它不是 Lindy 的 key。  
它只是为了防止别人随便调用你的桥接层。

你可以自己随便定一个字符串，例如：

```env
BRIDGE_API_KEY=my-bridge-key
```

以后你的客户端调用桥接服务时，也要带这个 key。

#### `ADMIN_TOKEN`

可选。

用于单独保护管理页面的配置 API。

如果你不设置它：

- 但设置了 `BRIDGE_API_KEY`，管理 API 会复用 `BRIDGE_API_KEY`
- 两者都没设置时，管理 API 只允许本机访问

#### `LINDY_CALLBACK_TOKEN`

可选，但强烈建议设置。

作用是：

当 Lindy 回调你的桥接服务时，桥接服务会检查 URL 里的 token 对不对。  
这样能防止别人伪造回调。

#### `REQUEST_TIMEOUT_MS`

桥接服务等待 Lindy 回调的最长时间。

默认：

```env
120000
```

也就是 120 秒。

### 3. 启动服务

直接运行：

```bash
node server.mjs
```

### 4. 打开可视化管理页面

服务启动后，可以直接访问：

```text
http://127.0.0.1:8787/__admin
```

它可以做这些事：

- 管理 `PUBLIC_BASE_URL`、`BRIDGE_API_KEY`、`LINDY_CALLBACK_TOKEN`、`REQUEST_TIMEOUT_MS`
- 可视化维护多个 webhook 与模型名的映射
- 保存到 `bridge.config.json`，并在不重启进程的情况下让新请求立即生效

如果你已经有 `.env` 配置，也没问题：

- 启动时先读 `.env` / `.env.local`
- 如果存在 `bridge.config.json`，则用它覆盖同名配置
- 所以你可以先用 `.env` 起服务，再逐步迁移到管理页面

服务会自动读取当前目录下的：

- `.env`
- `.env.local`

启动后你应该能看到类似日志：

```text
Lindy 桥接服务已启动: http://127.0.0.1:8787
公开回调基地址: https://your-public-bridge.example.com
可用模型路由: default
```

### 4. 健康检查

浏览器或 `curl` 打开：

```text
http://127.0.0.1:8787/healthz
```

正常应该返回：

```json
{
  "ok": true,
  "routes": ["default"]
}
```

---

## 第二步：先做一次本地自检

在真正接 Lindy 之前，你可以先跑项目内置的冒烟测试。

命令：

```bash
node scripts/smoke-test.mjs
```

这个测试不会真的调用 Lindy。  
它会在本地起一个假的 webhook 服务，模拟 Lindy 的回调过程。

如果看到：

```text
smoke 测试通过
```

说明桥接服务自己的核心逻辑是通的。

## 第三步：准备一个公网地址

这一节只讲原则，不强绑定某一个具体服务。

### 为什么必须公网可达

因为这条链路里，`Lindy` 处理完以后要主动来请求你：

```text
POST https://你的公网地址/__lindy/callback/...
```

如果你的地址只在本机能访问到，例如：

```text
http://127.0.0.1:8787
```

那 Lindy 无法回调。

### 你需要达到什么效果

你最终要拥有一个这样的地址：

```text
https://something-public.example.com
```

并且它访问的其实就是你本地或服务器上的 `8787` 端口服务。

### 成功后的验证方式

当你拿到公网地址后，把它填进：

```env
PUBLIC_BASE_URL=https://something-public.example.com
```

然后从外部访问：

```text
https://something-public.example.com/healthz
```

如果能拿到正常 JSON，就说明公网回调这一步基本没问题。

---

## 第四步：在 Lindy 后台创建 workflow

这一节最关键。

我们先做最简单、最稳定的一版：

```text
Webhook Received -> LLM Call -> Send POST Request to Callback
```

### 为什么先不用 AI Agent

因为你现在的目标是：

“先把 Lindy 变成一个可以像 API 那样调用的文本后端”

`LLM Call` 更适合这个目标，因为它：

- 更接近普通模型调用
- 更便宜
- 更容易控制
- 更容易调试

以后你再把它升级成 `AI Agent` 也不迟。

### 1. 新建 workflow

在 Lindy 后台：

1. 新建一个 workflow
2. 添加 trigger
3. 选择 `Webhook Received`

### 2. 创建 webhook

在 `Webhook Received` 里：

1. 选择“创建新的 webhook”
2. 给它一个清楚的名字

建议名字：

```text
bridge-default
```

3. 生成 Secret
4. 复制 webhook URL
5. 复制 Secret

你稍后会把这两个值分别填进：

- `LINDY_WEBHOOK_URL`
- `LINDY_WEBHOOK_SECRET`

### 3. Follow-up Behavior 怎么选

建议先选：

```text
Create new task
```

原因很简单：

- 标准 API 请求通常彼此独立
- 我们先不要让不同请求在 Lindy 内部共享状态

### 4. webhook 收到的内容长什么样

桥接服务发给 Lindy webhook 的 JSON 大致是：

```json
{
  "jobId": "uuid",
  "callbackUrl": "https://your-public-bridge.example.com/__lindy/callback/uuid?token=xxx",
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

你在 Lindy 后台不需要手写这个 JSON。  
你只需要知道：

- 它会从 webhook 请求体里收到这些字段
- 你后面的节点要把它们取出来用

### 5. 如何在 Lindy 里引用 webhook 请求体字段

官方文档明确给出的入口变量是：

- `{{webhook_received.request.body}}`
- `{{webhook_received.request.headers}}`
- `{{webhook_received.request.query}}`

重点提醒：

不要手打猜变量名。  
最稳的方式是：

1. 点击 Lindy 编辑器里的变量选择器
2. 展开 `webhook_received`
3. 展开 `request`
4. 展开 `body`
5. 直接点选你需要的字段

你应该能看到与这些字段对应的内容：

- `system`
- `prompt`
- `lastUserMessage`
- `callbackUrl`
- `requestedModel`

### 6. 添加 `LLM Call`

在 `Webhook Received` 后面添加一个 `LLM Call` 节点。

#### `Model Provider`

第一版建议在 Lindy 里固定一个模型。

也就是说：

- 不要一开始就在同一个 workflow 里做“动态切模型”
- 先让这个 workflow 只代表一个固定模型

为什么？

因为这样最稳定。

如果你以后想让不同 `model` 名映射到不同 Lindy 模型，推荐做法是：

- 建多个 Lindy webhook
- 每个 webhook 对应一个固定模型
- 在桥接层用 `LINDY_ROUTES` 做路由

#### `System Prompt`

这里建议使用 webhook 请求体里的 `system` 字段。

如果你的 UI 支持条件逻辑，也可以加兜底提示词。  
最简单版本可以先直接绑定 `system`。

#### `User Prompt`

这里建议直接使用 webhook 请求体里的 `prompt` 字段。

为什么不是自己再拼一遍 `messages`？

因为桥接层已经替你把完整历史整理成了 `prompt` 文本，而且默认不再重复包含 `system`。

#### `Temperature`

第一版建议先固定值，例如：

```text
0.2
```

#### `Max Output Tokens`

第一版也建议先固定值，例如：

```text
1024
```

先跑通，再考虑把这些也做成动态变量。

### 7. 添加 `Send POST Request to Callback`

在 `LLM Call` 后面添加 `Send POST Request to Callback`。

#### 回调地址怎么填

这里填 webhook 请求体里的：

```text
callbackUrl
```

也就是桥接层传过来的回调地址。

#### 回调 Body 怎么填

建议最小返回：

```json
{
  "content": "这里放 LLM 最终回复"
}
```

这里的 `"这里放 LLM 最终回复"`，不要手写成文字。  
你需要在 Lindy 编辑器里点选 `LLM Call` 的输出变量。

文档明确说 `LLM Call` 有输出 `AI Response`，但不同 UI 里的变量展示可能略有不同，所以还是那句话：

- 不要凭空猜变量名
- 直接用 Lindy 变量选择器点选输出

### 8. 建议的回调格式

最稳建议：

```json
{
  "content": "模型最终文本回复"
}
```

如果你能拿到更丰富的字段，也可以这样：

```json
{
  "content": "模型最终文本回复",
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

桥接层目前至少识别这些字段之一作为文本结果：

- `content`
- `text`
- `response`
- `assistant_response`

但推荐统一用 `content`。

---

## 第五步：把 Lindy 的 webhook 信息填回 `.env`

当你在 Lindy 里创建好 webhook 后，把值填回本项目的 `.env`：

```env
PORT=8787
PUBLIC_BASE_URL=https://你的公网桥接地址
BRIDGE_API_KEY=你自定义的桥接层key
LINDY_CALLBACK_TOKEN=你自定义的回调token
REQUEST_TIMEOUT_MS=120000

LINDY_WEBHOOK_URL=https://public.lindy.ai/api/v1/webhooks/xxxxxxxx
LINDY_WEBHOOK_SECRET=你在Lindy里生成的secret
```

然后重启桥接服务：

```bash
node server.mjs
```

---

## 第六步：第一次真实测试

### 用 `curl` 测试 OpenAI 兼容接口

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-local-api-key" \
  -d '{
    "model": "default",
    "messages": [
      {
        "role": "system",
        "content": "你是一个严谨的中文助手。"
      },
      {
        "role": "user",
        "content": "请用一句话解释 webhook 是什么。"
      }
    ]
  }'
```

### 你会看到什么

如果全部配置正确，链路会这样走：

1. `curl` 打到桥接层
2. 桥接层把请求发给 Lindy webhook
3. Lindy workflow 被触发
4. Lindy 执行 `LLM Call`
5. Lindy 用 callback 把结果打回桥接层
6. 桥接层返回标准 JSON 响应

正常返回大致像：

```json
{
  "id": "chatcmpl_xxx",
  "object": "chat.completion",
  "created": 1710000000,
  "model": "default",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Webhook 就是一个可被外部 HTTP 请求触发的自动化入口。"
      },
      "finish_reason": "stop"
    }
  ]
}
```

---

## 第七步：接 OpenAI SDK

示例文件：

- [examples/openai-sdk.mjs](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/examples/openai-sdk.mjs)

核心配置只有两点：

1. `apiKey` 填你自己的 `BRIDGE_API_KEY`
2. `baseURL` 指向桥接层的 `/v1`

示例：

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "my-bridge-key",
  baseURL: "http://127.0.0.1:8787/v1",
});

const completion = await client.chat.completions.create({
  model: "default",
  messages: [
    { role: "system", content: "你是一个严谨的中文助手。" },
    { role: "user", content: "请用一句话解释 webhook 是什么。" },
  ],
});

console.log(completion.choices[0]?.message?.content);
```

## 第八步：接 Anthropic SDK

示例文件：

- [examples/anthropic-sdk.mjs](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/examples/anthropic-sdk.mjs)

核心差异：

- `Anthropic` 的 `baseURL` 指向桥接层根路径，不要自己再手动加 `/v1/messages`

示例：

```js
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: "my-bridge-key",
  baseURL: "http://127.0.0.1:8787",
});

const message = await client.messages.create({
  model: "default",
  max_tokens: 512,
  system: "你是一个严谨的中文助手。",
  messages: [
    { role: "user", content: "请用一句话解释 webhook 是什么。" },
  ],
});
```

---

## 多模型怎么做

如果你只想先跑通，完全可以只用单 webhook。

### 单 webhook 模式

所有请求都走一个 Lindy workflow：

```env
LINDY_WEBHOOK_URL=...
LINDY_WEBHOOK_SECRET=...
```

此时你传什么 `model`，最终都会落到 `default` 路由。

### 多 webhook 模式

如果你想：

- `model=default` 走一个 workflow
- `model=gpt-4.1-mini` 走另一个 workflow
- `model=claude-3-7-sonnet-latest` 走第三个 workflow

就用：

```env
LINDY_ROUTES={"default":{"webhookUrl":"https://public.lindy.ai/api/v1/webhooks/default","webhookSecret":"secret-default"},"gpt-4.1-mini":{"webhookUrl":"https://public.lindy.ai/api/v1/webhooks/gpt","webhookSecret":"secret-gpt"},"claude-3-7-sonnet-latest":{"webhookUrl":"https://public.lindy.ai/api/v1/webhooks/claude","webhookSecret":"secret-claude"}}
```

推荐策略是：

- 一个 Lindy workflow 固定一个模型
- 不要在同一个 workflow 里做复杂的动态模型选择

这样最好调试。

---

## Docker 部署

项目已经带了：

- [Dockerfile](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/Dockerfile)
- [.dockerignore](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/.dockerignore)

### 构建镜像

```bash
docker build -t lindy2api .
```

### 运行容器

```bash
docker run --rm -p 8787:8787 \
  -e PORT=8787 \
  -e PUBLIC_BASE_URL=https://bridge.example.com \
  -e LINDY_WEBHOOK_URL=https://public.lindy.ai/api/v1/webhooks/your-webhook-id \
  -e LINDY_WEBHOOK_SECRET=your-lindy-webhook-secret \
  -e BRIDGE_API_KEY=your-local-api-key \
  lindy2api
```

更详细的部署说明见：

- [docs/deploy.md](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/docs/deploy.md)

---

## 常见问题排查

### 1. `/healthz` 正常，但真实请求超时

最常见原因是：

- Lindy workflow 没有正确回调 `callbackUrl`
- `PUBLIC_BASE_URL` 写错
- 公网地址根本访问不到你的桥接服务
- 反向代理没放行 `POST /__lindy/callback/...`

优先检查：

1. Lindy 任务执行记录
2. 回调动作是否成功
3. 公网地址能否访问 `https://你的地址/healthz`

### 2. Lindy 被触发了，但返回内容为空

优先检查：

- `LLM Call` 的 `User Prompt` 是否真的绑定到了 `prompt`
- `LLM Call` 输出变量是否选对
- 回调 Body 里的 `content` 是否真的引用了模型输出

### 3. OpenAI 客户端拿到 `502`

这通常表示：

- 桥接层已经收到了你的请求
- 但 Lindy webhook 调用失败，或 Lindy 回调失败

不是桥接服务本身没启动。

### 4. OpenAI SDK 连不上

检查这两个点：

1. `baseURL` 是否写成：

```text
http://127.0.0.1:8787/v1
```

2. `apiKey` 是否与 `BRIDGE_API_KEY` 一致

### 5. Anthropic SDK 连不上

检查 `baseURL` 是否写成：

```text
http://127.0.0.1:8787
```

不要多拼一层错误路径。

### 6. PowerShell 里 `npm` 跑不起来

你这台机器的 PowerShell 可能会拦 `npm.ps1`。

所以优先这样跑：

```bash
node scripts/smoke-test.mjs
```

或者：

```bash
npm.cmd run smoke
```

不要默认直接敲：

```bash
npm run smoke
```

---

## 安全建议

虽然这是本地桥接项目，但还是建议你至少做这几件事：

### 1. 给桥接层设置 `BRIDGE_API_KEY`

否则任何能访问你桥接服务的人都可以调用它。

### 2. 给回调设置 `LINDY_CALLBACK_TOKEN`

这样别人不能轻易伪造 Lindy 回调。

### 3. 不要把 Lindy webhook secret 提交到仓库

所以项目已经把下面这些加进了忽略：

- `.env`
- `.env.local`

### 4. 公网部署时最好放在 HTTPS 后面

特别是你要把它长期暴露在公网时。

---

## 这个项目现在最推荐的使用方式

如果你问我“最实用、最不折腾的一套方案是什么”，答案是：

1. 本项目部署在一个你能控制的公网地址上
2. Lindy 里为每个模型建一个固定 workflow
3. 每个 workflow 理想上是：

```text
Webhook Received -> LLM Call -> Send POST Request to Callback
```

如果你的账号 UI 里根本没有 `Send POST Request to Callback`，就改成：

```text
Webhook Received -> LLM Call -> HTTP Request
```

4. 通过 `LINDY_ROUTES` 按 `model` 名分发到不同 webhook

这套方案的优点：

- 稳
- 简单
- 容易排错
- 不依赖未公开接口

---

## 如果你只想最快跑通

请按下面最短清单做：

1. 写 `.env`
2. `node server.mjs`
3. 确保你有公网地址，并能访问 `/healthz`
4. 在 Lindy 建：

```text
Webhook Received -> LLM Call -> Send POST Request to Callback
```

如果你搜不到 `Send POST Request to Callback`，就用：

```text
Webhook Received -> LLM Call -> HTTP Request
```

5. 把 Lindy webhook URL 和 secret 填回 `.env`
6. 用 `curl` 打 `/v1/chat/completions`

如果这一步通了，后面 SDK 接入就只是换 `baseURL` 的问题。

---

## 如果你找不到 `Send POST Request to Callback`

有些 Lindy 账号或当前 UI 版本里，官方文档提到的这个 action / skill 不一定实际显示出来。  
如果你在：

- 画布 `+` 的 action 搜索
- `AI Agent` 的 skills 搜索

里都找不到它，就不要继续卡在这里，直接用普通的 `HTTP Request` action 代替。

### 桥接层现在支持两种回调方式

发给 Lindy webhook 的请求体里，会同时包含：

```json
{
  "jobId": "uuid",
  "requestId": "uuid",
  "callbackUrl": "https://your-bridge.example.com/__lindy/callback/uuid?token=xxx",
  "callbackRequestUrl": "https://your-bridge.example.com/__lindy/callback?token=xxx"
}
```

区别：

- `callbackUrl`：动态路径，适合文档里的专用 callback action
- `callbackRequestUrl`：固定路径，适合你手动用 `HTTP Request` 回调

### 你应该怎么配 `HTTP Request`

- 优先用 `callbackUrl`
- `Content-Type` 优先用 `text/plain`
- 直接把 `LLM Call` 的最终文本输出作为整个 body 发回，不要手写 JSON 包装

这样最稳，因为模型回复里常见的换行、制表符和其他控制字符，不会再把最后一步的 JSON 模板弄坏。

如果你在 Lindy 里看到这种报错：

```text
The request body is not valid JSON: Bad control character in string literal in JSON ...
```

基本就是最后一步把 LLM 输出直接拼进 JSON body 了。

推荐配置：

- `Method`：`POST`
- `URL`：`callbackUrl`
- `Content-Type`：`text/plain`
- `Body`：`LLM Call` 的最终文本输出

因为 `callbackUrl` 自己已经带了 `jobId`，桥接层会把整个请求体当成最终 `content`。

如果你的 UI 限制必须发 JSON，再退回下面这个方案：

- `Method`：`POST`
- `URL`：`callbackRequestUrl`
- `Content-Type`：`application/json`
- `Body`：至少发回这两个字段

```json
{
  "jobId": "原请求的 jobId",
  "content": "最终模型回答"
}
```

桥接层会根据 `jobId` 找回原始请求，再把 `content` 返回给你的 OpenAI / Anthropic 客户端。
只有在你确认变量会被正确 JSON 转义时，才建议用这个回退方案。

如果你只能使用固定的 `callbackRequestUrl`，但又想保留 `text/plain`，也可以把 `jobId` 放到查询参数 `?jobId=...`，或者放到请求头 `x-lindy-job-id`。

### 如果你拿不到 `body.system` / `body.prompt`

桥接层现在额外提供了一个辅助 endpoint：

```text
POST /__lindy/prepare?token=你的 LINDY_CALLBACK_TOKEN
```

它会把 Lindy 手里的原始 webhook body 再整理一遍，返回更适合后续节点直接绑定的字段：

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

推荐链路：

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

### 对你当前这种 UI 限制，推荐工作流

如果你拿不到展开后的 `body.prompt` / `body.jobId`，又没有 callback skill，推荐这样配：

```text
Webhook Received
-> HTTP Request（field=system）
-> HTTP Request（field=prompt）
-> HTTP Request（field=jobId）
-> LLM Call（System Prompt 用 system 节点输出，User Prompt 用 prompt 节点输出）
-> HTTP Request（固定 callback URL，header 里带 x-lindy-job-id，body 放最终文本）
```

如果你能正常消费前一步 HTTP 返回的 JSON 字段，也可以走更少节点的版本：

```text
Webhook Received
-> HTTP Request（POST 到 /__lindy/prepare）
-> 正式模型 LLM Call（直接用 prepare 的 system / prompt）
-> HTTP Request（优先 POST 到 callbackUrl，`text/plain` 回调）
```

如果你不方便加这个辅助 HTTP Request，再退回旧方案：

```text
Webhook Received
-> 便宜模型 LLM Call（从 body 提取 prompt 和 jobId）
-> 正式模型 LLM Call（回答问题）
-> HTTP Request（优先 POST 到 callbackUrl，`text/plain` 回调）
```

---

## 更多文件

如果你想继续看更细的拆分说明：

- Lindy 工作流配置细节：
  [docs/lindy-workflow-setup.md](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/docs/lindy-workflow-setup.md)
- 部署细节：
  [docs/deploy.md](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/docs/deploy.md)
- SDK 接入细节：
  [docs/sdk-examples.md](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/docs/sdk-examples.md)

---

## 官方资料来源

这份项目和教程基于以下官方资料整理：

- Lindy Webhooks: https://docs.lindy.ai/skills/by-lindy/webhooks
- Lindy LLM Call: https://docs.lindy.ai/skills/lindy-utilities/llm-call
- Lindy Chat with Lindy: https://docs.lindy.ai/skills/by-lindy/chat-with-lindy
- Lindy Pricing: https://docs.lindy.ai/pricing
- Lindy Usage: https://docs.lindy.ai/account-billing/usage
- Lindy Credits: https://docs.lindy.ai/account-billing/credits
- OpenAI Node SDK README: https://raw.githubusercontent.com/openai/openai-node/master/README.md
- OpenAI Node SDK `baseURL` 选项源码: https://raw.githubusercontent.com/openai/openai-node/master/src/client.ts
- Anthropic TypeScript SDK 文档: https://platform.claude.com/docs/en/api/sdks/typescript
- Anthropic SDK `baseURL` 选项源码: https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/src/client.ts
