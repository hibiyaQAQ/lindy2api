import { createServer } from "node:http";
import { existsSync, rmSync } from "node:fs";
import { startBridgeServer, stopBridgeServer } from "../server.mjs";

const BRIDGE_PORT = 8787;
const MOCK_PORT = 9900;

const mockServer = createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/mock")) {
    res.writeHead(404);
    res.end();
    return;
  }

  const body = await readJson(req);

  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");

  let callbackResponse;

  if (body.lastUserMessage === "请返回纯文本回调") {
    callbackResponse = await fetch(body.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
      body: "纯文本回调第一行\n第二行\t保留",
    });
  } else if (body.lastUserMessage === "请返回损坏 JSON 回调") {
    callbackResponse = await fetch(body.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{\n  \"content\": \"损坏 JSON 第一行\n第二行\t保留\"\n}",
    });
  } else {
    const usage =
      body.apiFlavor === "anthropic"
        ? {
            input_tokens: 12,
            output_tokens: 4,
          }
        : {
            prompt_tokens: 12,
            completion_tokens: 4,
            total_tokens: 16,
          };

    callbackResponse = await fetch(body.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: resolveMockResponseText(req.url),
        usage,
      }),
    });
  }

  if (!callbackResponse.ok) {
    throw new Error(`回调请求失败: ${callbackResponse.status} ${await callbackResponse.text()}`);
  }
});

try {
  process.env.PORT = String(BRIDGE_PORT);
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
  process.env.LINDY_WEBHOOK_URL = `http://127.0.0.1:${MOCK_PORT}/mock`;
  process.env.LINDY_WEBHOOK_SECRET = "smoke-secret";
  process.env.LINDY_CALLBACK_TOKEN = "smoke-callback-token";
  process.env.BRIDGE_CONFIG_PATH = "bridge.config.smoke.json";

  cleanupManagedConfig();

  await listen(mockServer, MOCK_PORT);
  await startBridgeServer();
  await waitForHealthz();

  await assertLindyPrepareEndpoint();
  await assertOpenAICompletion("请返回标准回调", "桥接验证成功");
  await assertOpenAICompletion("请返回纯文本回调", "纯文本回调第一行\n第二行\t保留");
  await assertOpenAICompletion("请返回损坏 JSON 回调", "损坏 JSON 第一行\n第二行\t保留");
  await assertOpenAIPseudoStream("请返回标准回调", "桥接验证成功");
  await assertAnthropicPseudoStream("桥接验证成功");
  await assertAdminUiAccessible();
  await assertAdminConfigFlow();

  console.log("smoke 测试通过");
} finally {
  mockServer.close();
  await stopBridgeServer();
  cleanupManagedConfig();
}

async function assertOpenAICompletion(userMessage, expectedText, options = {}) {
  const apiKey = options.apiKey || "";
  const model = options.model || "default";
  const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...buildBridgeAuthHeaders(apiKey),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "你是测试助手" },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`桥接请求失败: ${response.status} ${await response.text()}`);
  }

  const json = await response.json();
  const text = json?.choices?.[0]?.message?.content;

  if (text !== expectedText) {
    throw new Error(`桥接返回内容不符合预期: ${JSON.stringify(json)}`);
  }
}

async function assertOpenAIPseudoStream(userMessage, expectedText) {
  const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...buildBridgeAuthHeaders(process.env.BRIDGE_API_KEY || ""),
    },
    body: JSON.stringify({
      model: "default",
      stream: true,
      stream_options: {
        include_usage: true,
      },
      messages: [
        { role: "system", content: "你是测试助手" },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI 伪流式请求失败: ${response.status} ${await response.text()}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    throw new Error(`OpenAI 伪流式 content-type 不正确: ${contentType}`);
  }

  const events = parseSseEvents(await response.text());
  if (events.length !== 5) {
    throw new Error(`OpenAI 伪流式事件数量不符合预期: ${JSON.stringify(events)}`);
  }

  const roleChunk = JSON.parse(events[0].data);
  const contentChunk = JSON.parse(events[1].data);
  const finishChunk = JSON.parse(events[2].data);
  const usageChunk = JSON.parse(events[3].data);

  if (roleChunk?.choices?.[0]?.delta?.role !== "assistant") {
    throw new Error(`OpenAI 伪流式首块格式不正确: ${JSON.stringify(roleChunk)}`);
  }

  if (contentChunk?.choices?.[0]?.delta?.content !== expectedText) {
    throw new Error(`OpenAI 伪流式内容块不符合预期: ${JSON.stringify(contentChunk)}`);
  }

  if (finishChunk?.choices?.[0]?.finish_reason !== "stop") {
    throw new Error(`OpenAI 伪流式结束块不符合预期: ${JSON.stringify(finishChunk)}`);
  }

  if (
    !Array.isArray(usageChunk?.choices) ||
    usageChunk.choices.length !== 0 ||
    usageChunk?.usage?.total_tokens !== 16
  ) {
    throw new Error(`OpenAI 伪流式 usage 块不符合预期: ${JSON.stringify(usageChunk)}`);
  }

  if (events[4].data !== "[DONE]") {
    throw new Error(`OpenAI 伪流式缺少 [DONE]: ${JSON.stringify(events)}`);
  }
}

async function assertAnthropicPseudoStream(expectedText) {
  const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...buildAnthropicAuthHeaders(process.env.BRIDGE_API_KEY || ""),
    },
    body: JSON.stringify({
      model: "default",
      max_tokens: 512,
      stream: true,
      system: "你是测试助手",
      messages: [
        {
          role: "user",
          content: "请返回标准回调",
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic 伪流式请求失败: ${response.status} ${await response.text()}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    throw new Error(`Anthropic 伪流式 content-type 不正确: ${contentType}`);
  }

  const anthropicVersion = response.headers.get("anthropic-version");
  if (anthropicVersion !== "2023-06-01") {
    throw new Error(`Anthropic 伪流式版本头不正确: ${anthropicVersion}`);
  }

  const events = parseSseEvents(await response.text());
  const eventNames = events.map((event) => event.event);
  const expectedNames = [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ];

  if (JSON.stringify(eventNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`Anthropic 伪流式事件顺序不符合预期: ${JSON.stringify(events)}`);
  }

  const messageStart = JSON.parse(events[0].data);
  const contentDelta = JSON.parse(events[2].data);
  const messageDelta = JSON.parse(events[4].data);

  if (messageStart?.message?.usage?.input_tokens !== 12) {
    throw new Error(`Anthropic 伪流式起始 usage 不符合预期: ${JSON.stringify(messageStart)}`);
  }

  if (contentDelta?.delta?.text !== expectedText) {
    throw new Error(`Anthropic 伪流式文本块不符合预期: ${JSON.stringify(contentDelta)}`);
  }

  if (
    messageDelta?.delta?.stop_reason !== "end_turn" ||
    messageDelta?.usage?.output_tokens !== 4
  ) {
    throw new Error(`Anthropic 伪流式结束块不符合预期: ${JSON.stringify(messageDelta)}`);
  }
}

async function assertAdminUiAccessible() {
  const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/__admin/`);
  if (!response.ok) {
    throw new Error(`管理页面无法访问: ${response.status} ${await response.text()}`);
  }

  const html = await response.text();
  if (!html.includes("Lindy2API 管理台")) {
    throw new Error("管理页面内容不符合预期");
  }
}

async function assertAdminConfigFlow() {
  const initialResponse = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/__admin/api/config`);
  if (!initialResponse.ok) {
    throw new Error(`读取管理配置失败: ${initialResponse.status} ${await initialResponse.text()}`);
  }

  const initialJson = await initialResponse.json();
  if (initialJson?.config?.routes?.[0]?.model !== "default") {
    throw new Error(`管理配置初始路由不符合预期: ${JSON.stringify(initialJson)}`);
  }

  const nextConfig = {
    publicBaseUrl: `http://127.0.0.1:${BRIDGE_PORT}`,
    bridgeApiKey: "admin-bridge-key",
    callbackToken: "smoke-callback-token",
    requestTimeoutMs: 90000,
    adminToken: "",
    routes: [
      {
        model: "default",
        webhookUrl: `http://127.0.0.1:${MOCK_PORT}/mock-default`,
        webhookSecret: "secret-default",
        timeoutMs: 70000,
      },
      {
        model: "gpt-4.1-mini",
        webhookUrl: `http://127.0.0.1:${MOCK_PORT}/mock-gpt`,
        webhookSecret: "secret-gpt",
        timeoutMs: 60000,
      },
    ],
  };

  const saveResponse = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/__admin/api/config`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(nextConfig),
  });

  if (!saveResponse.ok) {
    throw new Error(`保存管理配置失败: ${saveResponse.status} ${await saveResponse.text()}`);
  }

  const saveJson = await saveResponse.json();
  if (saveJson?.runtime?.adminAuthSource !== "bridge_api_key") {
    throw new Error(`管理配置鉴权模式不符合预期: ${JSON.stringify(saveJson)}`);
  }

  const modelsResponse = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/models`);
  if (!modelsResponse.ok) {
    throw new Error(`读取模型列表失败: ${modelsResponse.status} ${await modelsResponse.text()}`);
  }

  const modelsJson = await modelsResponse.json();
  const modelIds = (modelsJson?.data || []).map((item) => item.id).sort();
  if (JSON.stringify(modelIds) !== JSON.stringify(["default", "gpt-4.1-mini"])) {
    throw new Error(`模型列表未按新配置更新: ${JSON.stringify(modelsJson)}`);
  }

  const authedConfigResponse = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/__admin/api/config`, {
    headers: {
      "x-admin-token": "admin-bridge-key",
    },
  });

  if (!authedConfigResponse.ok) {
    throw new Error(`管理接口鉴权失败: ${authedConfigResponse.status} ${await authedConfigResponse.text()}`);
  }

  await assertOpenAICompletion("请返回标准回调", "gpt 路由验证成功", {
    model: "gpt-4.1-mini",
    apiKey: "admin-bridge-key",
  });
  await assertOpenAICompletion("请返回标准回调", "默认路由验证成功", {
    model: "not-configured-model",
    apiKey: "admin-bridge-key",
  });

  if (!existsSync(process.env.BRIDGE_CONFIG_PATH)) {
    throw new Error("保存管理配置后未生成配置文件");
  }
}

async function assertLindyPrepareEndpoint() {
  const prepareUrl = `http://127.0.0.1:${BRIDGE_PORT}/__lindy/prepare?token=${process.env.LINDY_CALLBACK_TOKEN}`;

  const directResponse = await fetch(prepareUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      body: {
        jobId: "job-1",
        callbackUrl: "https://example.com/callback",
        callbackRequestUrl: "https://example.com/callback-static",
        system: "你是测试助手",
        prompt: "请直接回答：你好",
        lastUserMessage: "你好",
      },
    }),
  });

  if (!directResponse.ok) {
    throw new Error(`prepare 接口请求失败: ${directResponse.status} ${await directResponse.text()}`);
  }

  const directJson = await directResponse.json();
  if (
    directJson.jobId !== "job-1" ||
    directJson.system !== "你是测试助手" ||
    directJson.prompt !== "请直接回答：你好" ||
    directJson.source !== "body"
  ) {
    throw new Error(`prepare 接口返回内容不符合预期: ${JSON.stringify(directJson)}`);
  }

  const rawJsonResponse = await fetch(prepareUrl, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: "你是系统提示" },
        { role: "user", content: "你好" },
      ],
    }),
  });

  if (!rawJsonResponse.ok) {
    throw new Error(`prepare 文本请求失败: ${rawJsonResponse.status} ${await rawJsonResponse.text()}`);
  }

  const rawJson = await rawJsonResponse.json();
  if (
    rawJson.system !== "你是系统提示" ||
    rawJson.lastUserMessage !== "你好" ||
    rawJson.prompt.includes("系统指令：\n你是系统提示") ||
    !rawJson.prompt.includes("user：\n你好")
  ) {
    throw new Error(`prepare 文本返回内容不符合预期: ${JSON.stringify(rawJson)}`);
  }

  const fieldResponse = await fetch(`${prepareUrl}&field=prompt`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      body: {
        system: "你是测试助手",
        prompt: "请直接回答：你好",
      },
    }),
  });

  if (!fieldResponse.ok) {
    throw new Error(`prepare 字段请求失败: ${fieldResponse.status} ${await fieldResponse.text()}`);
  }

  const fieldText = await fieldResponse.text();
  if (fieldText !== "请直接回答：你好") {
    throw new Error(`prepare 字段返回内容不符合预期: ${JSON.stringify(fieldText)}`);
  }
}

async function waitForHealthz() {
  for (let index = 0; index < 40; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // 服务尚未起来，继续轮询。
    }

    await sleep(250);
  }

  throw new Error("桥接服务启动超时");
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readJson(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

function parseSseEvents(text) {
  return text
    .split(/\r?\n\r?\n/u)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = block
        .split(/\r?\n/u)
        .find((line) => line.startsWith("event:"));
      const data = block
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");

      return {
        event: event ? event.slice(6).trim() : "",
        data,
      };
    });
}

function resolveMockResponseText(pathname) {
  if (pathname === "/mock-gpt") {
    return "gpt 路由验证成功";
  }

  if (pathname === "/mock-default") {
    return "默认路由验证成功";
  }

  return "桥接验证成功";
}

function buildBridgeAuthHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

function buildAnthropicAuthHeaders(apiKey) {
  return apiKey ? { "x-api-key": apiKey } : {};
}

function cleanupManagedConfig() {
  if (process.env.BRIDGE_CONFIG_PATH && existsSync(process.env.BRIDGE_CONFIG_PATH)) {
    rmSync(process.env.BRIDGE_CONFIG_PATH, { force: true });
  }
}
