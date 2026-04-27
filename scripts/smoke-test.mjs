import { createServer } from "node:http";
import { startBridgeServer, stopBridgeServer } from "../server.mjs";

const BRIDGE_PORT = 8787;
const MOCK_PORT = 9900;

const mockServer = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/mock") {
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
    callbackResponse = await fetch(body.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: "桥接验证成功",
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
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

  await listen(mockServer, MOCK_PORT);
  await startBridgeServer();
  await waitForHealthz();

  await assertOpenAICompletion("请返回标准回调", "桥接验证成功");
  await assertOpenAICompletion("请返回纯文本回调", "纯文本回调第一行\n第二行\t保留");
  await assertOpenAICompletion("请返回损坏 JSON 回调", "损坏 JSON 第一行\n第二行\t保留");

  console.log("smoke 测试通过");
} finally {
  mockServer.close();
  await stopBridgeServer();
}

async function assertOpenAICompletion(userMessage, expectedText) {
  const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.BRIDGE_API_KEY
        ? { authorization: `Bearer ${process.env.BRIDGE_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({
      model: "default",
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
