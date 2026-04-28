# 部署说明

这份桥接服务没有运行时依赖，部署方式很简单。核心要求只有两个：

- 服务必须能对外提供 HTTP 接口。
- `PUBLIC_BASE_URL` 必须能被 `Lindy` 直接访问到。

## 环境变量

最少需要这几项：

```env
PORT=8787
BRIDGE_CONFIG_PATH=bridge.config.json
PUBLIC_BASE_URL=https://bridge.example.com
LINDY_WEBHOOK_URL=https://public.lindy.ai/api/v1/webhooks/your-webhook-id
LINDY_WEBHOOK_SECRET=your-lindy-webhook-secret
```

建议再加：

```env
BRIDGE_API_KEY=your-local-api-key
ADMIN_TOKEN=your-admin-token
LINDY_CALLBACK_TOKEN=your-callback-token
REQUEST_TIMEOUT_MS=120000
```

## 直接运行

项目支持自动读取当前目录下的 `.env` 和 `.env.local`。

如果同目录下存在 `bridge.config.json`（或 `BRIDGE_CONFIG_PATH` 指向的文件），服务还会继续读取它，并用它覆盖同名环境变量配置。

```bash
node server.mjs
```

## Docker

构建镜像：

```bash
docker build -t lindy2api .
```

运行容器：

```bash
docker run --rm -p 8787:8787 \
  -e PORT=8787 \
  -e PUBLIC_BASE_URL=https://bridge.example.com \
  -e LINDY_WEBHOOK_URL=https://public.lindy.ai/api/v1/webhooks/your-webhook-id \
  -e LINDY_WEBHOOK_SECRET=your-lindy-webhook-secret \
  -e BRIDGE_API_KEY=your-local-api-key \
  lindy2api
```

## 反向代理

如果你前面还有 Nginx、Caddy 或云平台网关，需要确认：

- `POST /v1/chat/completions` 和 `POST /v1/messages` 不被拦截。
- `POST /__lindy/callback/:jobId` 可以被公网回调访问。
- 如果你要远程打开管理页，还要放行 `GET /__admin` 和 `GET|PUT /__admin/api/config`。
- 超时时间不要太短，否则 Lindy 还没回调，上游就会先断开。

建议把网关超时至少放到 `120s` 以上，和 `REQUEST_TIMEOUT_MS` 保持一致或更长。

## 常见部署形态

### 单 webhook

适合先跑通。

- 一个 Lindy 工作流
- 一个 webhook URL
- 所有 `model` 请求都路由到 `default`

### 多 webhook

适合你想把不同模型名映射到不同 Lindy 工作流。

```env
LINDY_ROUTES={"default":{"webhookUrl":"https://public.lindy.ai/api/v1/webhooks/default","webhookSecret":"secret-default"},"gpt-4.1-mini":{"webhookUrl":"https://public.lindy.ai/api/v1/webhooks/gpt","webhookSecret":"secret-gpt","timeoutMs":120000},"claude-3-7-sonnet-latest":{"webhookUrl":"https://public.lindy.ai/api/v1/webhooks/claude","webhookSecret":"secret-claude","timeoutMs":120000}}
```

如果你不想继续手写这段 JSON，可以启动服务后直接打开：

```text
http://127.0.0.1:8787/__admin
```

管理页会把配置保存到 `bridge.config.json`，并支持在线维护模型名到 webhook 的映射关系。

## 健康检查

服务提供：

- `GET /healthz`
- `GET /v1/models`
- `GET /__admin`

你可以把 `GET /healthz` 作为平台健康检查。

正常响应示例：

```json
{
  "ok": true,
  "routes": ["default"]
}
```
