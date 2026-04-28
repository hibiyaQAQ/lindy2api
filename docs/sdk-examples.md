# SDK 接入示例

这份桥接层最直接的用途，就是让现有依赖 `OpenAI` 或 `Anthropic` SDK 的代码，改一个 `baseURL` 就能先接上 Lindy。

## OpenAI Node SDK

官方 `openai-node` 客户端支持 `baseURL` 选项；源码里 `ClientOptions` 明确写了 `baseURL`，默认是 `OPENAI_BASE_URL` 或官方地址。  
来源：

- OpenAI SDK README: https://raw.githubusercontent.com/openai/openai-node/master/README.md
- OpenAI SDK client options: https://raw.githubusercontent.com/openai/openai-node/master/src/client.ts

示例见 [examples/openai-sdk.mjs](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/examples/openai-sdk.mjs)。

## Anthropic TypeScript SDK

官方 `@anthropic-ai/sdk` 也支持 `baseURL` 选项；源码里 `ClientOptions` 明确写了 `baseURL`，默认是 `ANTHROPIC_BASE_URL` 或官方地址。  
来源：

- Anthropic TypeScript SDK docs: https://platform.claude.com/docs/en/api/sdks/typescript
- Anthropic SDK client options: https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/src/client.ts

示例见 [examples/anthropic-sdk.mjs](/C:/Users/cheju/Documents/git-hibiyaQAQ/lindy2api/examples/anthropic-sdk.mjs)。

## 通用原则

- OpenAI SDK 把 `baseURL` 设为 `http://127.0.0.1:8787/v1`
- Anthropic SDK 把 `baseURL` 设为 `http://127.0.0.1:8787`
- API Key 随便用一个你自己定义的字符串，只要和 `BRIDGE_API_KEY` 一致即可

## 什么时候不能无缝替换

如果你的原代码强依赖这些能力，就不能直接无缝迁移：

- 真正的逐 token 流式输出
- 工具调用
- 图像 / 音频 / 多模态输入
- 严格的 token 计费字段

当前项目支持 `stream=true` 的伪流式兼容：桥接层会先等待 Lindy 完整回调，再一次性按 SSE 格式返回，所以可以兼容必须发起流式请求的 SDK / 客户端，但不是模型边生成边下发。
