# Repository Guidelines

## 项目结构与模块组织
- `server.mjs` 是唯一服务入口，负责 OpenAI/Anthropic 兼容接口、Lindy 回调接收、路由分发与环境配置加载。
- `scripts/smoke-test.mjs` 是本地端到端烟雾测试；`test.ps1` 仅用于手工联调 webhook，请勿保留真实凭证。
- `examples/` 存放 SDK 接入示例，`docs/` 存放部署、工作流配置与调用说明，`.env.example` 提供最小可运行配置模板。

## 构建、测试与开发命令
- `npm.cmd start`：启动本地桥接服务，默认监听 `PORT=8787`。
- `npm.cmd run check`：对 `server.mjs` 做 Node 语法检查，适合快速自检。
- `npm.cmd run smoke`：启动本地 mock webhook，验证 `/v1/chat/completions` 到 Lindy 回调链路。
- `docker build -t lindy2api .`：构建容器镜像；部署前确认 `PUBLIC_BASE_URL` 能被公网访问。
- 在 Windows PowerShell 下优先使用 `npm.cmd`，避免本机执行策略拦截 `npm.ps1`。

## 架构概览
- 请求入口只有两类：`POST /v1/chat/completions` 和 `POST /v1/messages`，都由 `server.mjs` 统一标准化后转发到 Lindy webhook。
- 回调入口为 `/__lindy/callback` 或 `/__lindy/callback/:jobId`；修改该流程时要同时考虑超时、鉴权和 job 状态回收。
- 模型路由优先读取 `LINDY_ROUTES`，单 webhook 场景则退回 `LINDY_WEBHOOK_URL` 与 `LINDY_WEBHOOK_SECRET`。

## 编码风格与命名约定
- 使用 Node.js ESM，保持 2 空格缩进、双引号、分号，与现有 `server.mjs` 风格一致。
- 常量使用 `UPPER_SNAKE_CASE`，函数和局部变量使用 `camelCase`，环境变量统一大写下划线命名。
- 新增接口时遵循现有分层：公开 API 放在 `/v1/*`，内部回调保留在 `/__lindy/*`。

## 测试指南
- 当前仓库没有独立测试框架；提交前至少运行 `npm.cmd run check` 和 `npm.cmd run smoke`。
- 修改请求规范、回调解析或模型路由时，优先扩展 `scripts/smoke-test.mjs`，保证最小闭环仍可复现。
- 若调整文档示例或环境变量，需同步更新 `README.md`、`docs/` 和 `.env.example`。
- 新增 API 字段时，至少覆盖一个成功响应样例和一个失败场景，避免兼容层返回格式漂移。

## 提交与合并请求
- Git 历史目前仅有 `init`，尚未形成成熟约定；建议继续使用简短、祈使式主题，并在前缀中标明范围，例如 `feat: add route timeout override`。
- 每个提交聚焦单一变更。PR 需说明影响的接口、环境变量和文档，并在变更 API 行为时附上 `curl` 或 JSON 示例。
- 如果改动 `server.mjs` 的公开响应结构，请在 PR 描述中写明对 OpenAI 或 Anthropic 兼容性的影响。

## 文档与示例维护
- `examples/openai-sdk.mjs` 与 `examples/anthropic-sdk.mjs` 应保持可运行，接口签名变更后要一起检查。
- `docs/deploy.md`、`docs/sdk-examples.md` 与 `README.md` 中出现的命令、端口和环境变量名称应保持一致。

## 安全与配置提示
- 不要提交 `.env`、真实 `LINDY_WEBHOOK_SECRET`、`BRIDGE_API_KEY` 或回调 token。
- `test.ps1` 如用于共享或演示，先替换硬编码 URL 和密钥，再提交。
