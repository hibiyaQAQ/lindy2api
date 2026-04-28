import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const pendingJobs = new Map();

let config;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, {
        ok: true,
        routes: listModels(config.routes),
      });
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return sendJson(res, 200, {
        object: "list",
        data: listModels(config.routes).map((id) => ({
          id,
          object: "model",
          owned_by: "lindy-bridge",
        })),
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return await handleOpenAI(req, res);
    }

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      return await handleAnthropic(req, res);
    }

    if (req.method === "POST" && url.pathname === "/__lindy/prepare") {
      return await handleLindyPrepare(req, res, url);
    }

    if (
      req.method === "POST" &&
      (url.pathname === "/__lindy/callback" || url.pathname.startsWith("/__lindy/callback/"))
    ) {
      return await handleCallback(req, res, url);
    }

    return sendJson(res, 404, {
      error: {
        message: `未找到路径: ${url.pathname}`,
        type: "not_found_error",
      },
    });
  } catch (error) {
    console.error("未处理异常:", error);
    return sendJson(res, 500, {
      error: {
        message: error instanceof Error ? error.message : "服务器内部错误",
        type: "internal_server_error",
      },
    });
  }
});

export async function startBridgeServer() {
  if (!config) {
    loadEnvFiles();
    config = loadConfig();
  }

  if (server.listening) {
    return server;
  }

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("error", onError);
      reject(error);
    };

    server.once("error", onError);
    server.listen(config.port, () => {
      server.off("error", onError);
      resolve();
    });
  });

  console.log(`Lindy 桥接服务已启动: http://127.0.0.1:${config.port}`);
  console.log(`公开回调基地址: ${config.publicBaseUrl}`);
  console.log(`可用模型路由: ${listModels(config.routes).join(", ")}`);

  return server;
}

export async function stopBridgeServer() {
  if (!server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function handleOpenAI(req, res) {
  try {
    if (!authorizeClient(req)) {
      return sendOpenAIError(res, 401, "未授权");
    }

    const body = await readJson(req);

    if (body.stream === true) {
      return sendOpenAIError(res, 400, "当前桥接层不支持 stream=true");
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return sendOpenAIError(res, 400, "`messages` 必须是非空数组");
    }

    const normalized = normalizeOpenAIRequest(body);
    const job = await dispatchToLindy("openai", normalized);
    const callbackPayload = await waitForCallback(job);
    const assistantText = extractAssistantText(callbackPayload);

    return sendJson(res, 200, {
      id: `chatcmpl_${job.id}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: normalized.requestedModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: assistantText,
          },
          finish_reason: "stop",
        },
      ],
      ...(extractOpenAIUsage(callbackPayload)
        ? { usage: extractOpenAIUsage(callbackPayload) }
        : {}),
    });
  } catch (error) {
    return sendOpenAIError(
      res,
      classifyErrorStatus(error),
      error instanceof Error ? error.message : "未知错误",
    );
  }
}

async function handleAnthropic(req, res) {
  try {
    if (!authorizeClient(req)) {
      return sendAnthropicError(res, 401, "未授权");
    }

    const body = await readJson(req);

    if (body.stream === true) {
      return sendAnthropicError(res, 400, "当前桥接层不支持 stream=true");
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return sendAnthropicError(res, 400, "`messages` 必须是非空数组");
    }

    const normalized = normalizeAnthropicRequest(body);
    const job = await dispatchToLindy("anthropic", normalized);
    const callbackPayload = await waitForCallback(job);
    const assistantText = extractAssistantText(callbackPayload);

    return sendJson(res, 200, {
      id: `msg_${job.id}`,
      type: "message",
      role: "assistant",
      model: normalized.requestedModel,
      content: [
        {
          type: "text",
          text: assistantText,
        },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: extractAnthropicUsage(callbackPayload),
    });
  } catch (error) {
    return sendAnthropicError(
      res,
      classifyErrorStatus(error),
      error instanceof Error ? error.message : "未知错误",
    );
  }
}

async function handleCallback(req, res, url) {
  let jobId = getCallbackJobId(req, url);

  let payload;

  if (config.callbackToken) {
    const token = url.searchParams.get("token");
    if (token !== config.callbackToken) {
      return sendJson(res, 401, {
        error: {
          message: "回调 token 不正确",
          type: "authentication_error",
        },
      });
    }
  }

  try {
    payload = await readCallbackPayload(req);
  } catch (error) {
    rejectPendingJob(jobId, error);
    return sendJson(res, 400, {
      error: {
        message: error instanceof Error ? error.message : "回调请求体格式不正确",
        type: "invalid_request_error",
      },
    });
  }

  if (!jobId && payload && typeof payload === "object" && typeof payload.jobId === "string") {
    jobId = payload.jobId.trim();
  }

  if (!jobId || !pendingJobs.has(jobId)) {
    return sendJson(res, 404, {
      error: {
        message: "未找到对应的回调任务",
        type: "not_found_error",
      },
    });
  }

  const job = pendingJobs.get(jobId);

  if (!job) {
    return sendJson(res, 404, {
      error: {
        message: "任务已过期",
        type: "not_found_error",
      },
    });
  }

  clearTimeout(job.timeoutId);
  pendingJobs.delete(jobId);

  if (payload && typeof payload === "object" && "error" in payload && payload.error) {
    const message =
      typeof payload.error === "string"
        ? payload.error
        : payload.error.message || "Lindy 回调返回错误";
    job.reject(new Error(message));
  } else {
    job.resolve(payload);
  }

  return sendJson(res, 200, { ok: true });
}

async function handleLindyPrepare(req, res, url) {
  try {
    if (!authorizeInternalRequest(req, url)) {
      return sendJson(res, 401, {
        error: {
          message: "未授权",
          type: "authentication_error",
        },
      });
    }

    const payload = await readPreparePayload(req);
    const prepared = buildLindyPrepareResponse(payload);
    const field = url.searchParams.get("field")?.trim() || "";

    if (field) {
      return sendPreparedField(res, prepared, field);
    }

    return sendJson(res, 200, prepared);
  } catch (error) {
    const statusCode = classifyErrorStatus(error);
    return sendJson(res, statusCode, {
      error: {
        message: error instanceof Error ? error.message : "未知错误",
        type: statusCode >= 500 ? "api_error" : "invalid_request_error",
      },
    });
  }
}

function sendPreparedField(res, prepared, field) {
  if (!Object.prototype.hasOwnProperty.call(prepared, field)) {
    return sendJson(res, 400, {
      error: {
        message: `不支持的 prepare 字段: ${field}`,
        type: "invalid_request_error",
      },
    });
  }

  return sendText(res, 200, stringifyField(prepared[field]));
}

function getCallbackJobId(req, url) {
  const hasDynamicPath = url.pathname.startsWith("/__lindy/callback/");
  const pathJobId = hasDynamicPath ? url.pathname.split("/").pop() : "";
  const queryJobId = url.searchParams.get("jobId") ?? "";
  const headerJobId = readHeaderValue(req.headers["x-lindy-job-id"]);

  for (const candidate of [pathJobId, queryJobId, headerJobId]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function rejectPendingJob(jobId, error) {
  if (!jobId || !pendingJobs.has(jobId)) {
    return;
  }

  const job = pendingJobs.get(jobId);
  if (!job) {
    return;
  }

  clearTimeout(job.timeoutId);
  pendingJobs.delete(jobId);
  job.reject(error instanceof Error ? error : new Error(String(error)));
}

function authorizeInternalRequest(req, url) {
  if (authorizeClient(req)) {
    return true;
  }

  if (config.callbackToken) {
    const token = url.searchParams.get("token");
    if (token === config.callbackToken) {
      return true;
    }
  }

  return false;
}

function buildLindyPrepareResponse(payload) {
  const { body, source } = unwrapLindyPrepareBody(payload);
  const prepared = buildPreparedPromptContext(body);

  return {
    source,
    bodyText: JSON.stringify(body, null, 2),
    ...prepared,
  };
}

function unwrapLindyPrepareBody(payload) {
  const resolvedPayload = parsePossibleJsonValue(payload);

  if (resolvedPayload && typeof resolvedPayload === "object" && !Array.isArray(resolvedPayload)) {
    const candidates = [
      ["request.body", resolvedPayload.request?.body],
      ["body", resolvedPayload.body],
      ["webhook_received.request.body", resolvedPayload.webhook_received?.request?.body],
      ["webhookReceived.request.body", resolvedPayload.webhookReceived?.request?.body],
      ["input.body", resolvedPayload.input?.body],
    ];

    for (const [source, candidate] of candidates) {
      if (candidate == null) {
        continue;
      }

      const resolvedCandidate = parsePossibleJsonValue(candidate);
      if (resolvedCandidate && typeof resolvedCandidate === "object" && !Array.isArray(resolvedCandidate)) {
        return {
          body: resolvedCandidate,
          source,
        };
      }

      if (typeof resolvedCandidate === "string" && resolvedCandidate.trim()) {
        return {
          body: {
            rawBody: resolvedCandidate,
          },
          source,
        };
      }
    }

    return {
      body: resolvedPayload,
      source: "direct",
    };
  }

  if (typeof resolvedPayload === "string" && resolvedPayload.trim()) {
    return {
      body: {
        rawBody: resolvedPayload,
      },
      source: "direct",
    };
  }

  return {
    body: {},
    source: "direct",
  };
}

function buildPreparedPromptContext(body) {
  const reconstructed = reconstructPromptContext(body);
  const system = safeExtractText(body.system) || reconstructed.system;

  return {
    jobId: stringifyField(body.jobId),
    requestId: stringifyField(body.requestId),
    callbackUrl: stringifyField(body.callbackUrl),
    callbackRequestUrl: stringifyField(body.callbackRequestUrl),
    requestedModel: stringifyField(body.requestedModel || body.model),
    system,
    prompt: safeExtractText(body.prompt) || reconstructed.prompt,
    lastUserMessage: safeExtractText(body.lastUserMessage) || reconstructed.lastUserMessage,
    temperature: numberOrNull(body.temperature),
    maxTokens: numberOrNull(body.maxTokens ?? body.max_tokens),
    reconstructedSystem: reconstructed.system,
  };
}

function reconstructPromptContext(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return {
      system: "",
      prompt: "",
      lastUserMessage: "",
    };
  }

  const normalizedMessages = normalizeMessages(body.messages);
  const explicitSystem = safeExtractText(body.system);

  if (explicitSystem) {
    return {
      system: explicitSystem,
      prompt: buildPrompt(explicitSystem, normalizedMessages),
      lastUserMessage: findLastMessage(normalizedMessages, "user"),
    };
  }

  const systemMessages = normalizedMessages.filter((item) => item.role === "system");
  const nonSystemMessages = normalizedMessages.filter((item) => item.role !== "system");
  const system = systemMessages.map((item) => item.text).join("\n\n");

  return {
    system,
    prompt: buildPrompt(system, nonSystemMessages),
    lastUserMessage: findLastMessage(nonSystemMessages, "user"),
  };
}

function safeExtractText(value) {
  if (value == null) {
    return "";
  }

  try {
    return extractContentText(value);
  } catch {
    return stringifyField(value);
  }
}

function stringifyField(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value == null) {
    return "";
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value, null, 2);
}

async function dispatchToLindy(apiFlavor, normalized) {
  const route = pickRoute(config.routes, normalized.requestedModel);
  const jobId = randomUUID();
  const callbackUrl = buildCallbackUrl(jobId);

  const deferred = createDeferred();
  const timeoutMs = route.timeoutMs ?? config.requestTimeoutMs;
  const timeoutId = setTimeout(() => {
    pendingJobs.delete(jobId);
    deferred.reject(new Error(`等待 Lindy 回调超时（${timeoutMs}ms）`));
  }, timeoutMs);

  pendingJobs.set(jobId, {
    ...deferred,
    timeoutId,
  });

  const webhookBody = {
    jobId,
    requestId: jobId,
    callbackUrl,
    callbackRequestUrl: buildStaticCallbackUrl(),
    apiFlavor,
    requestedModel: normalized.requestedModel,
    system: normalized.system,
    messages: normalized.messages,
    prompt: normalized.prompt,
    lastUserMessage: normalized.lastUserMessage,
    temperature: normalized.temperature,
    maxTokens: normalized.maxTokens,
    metadata: normalized.metadata,
  };

  const response = await fetch(route.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(route.webhookSecret
        ? { authorization: `Bearer ${route.webhookSecret}` }
        : {}),
    },
    body: JSON.stringify(webhookBody),
  });

  if (!response.ok) {
    clearTimeout(timeoutId);
    pendingJobs.delete(jobId);
    const text = await safeReadText(response);
    throw new Error(
      `调用 Lindy webhook 失败: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`,
    );
  }

  return {
    id: jobId,
    route,
    promise: deferred.promise,
  };
}

function waitForCallback(job) {
  return job.promise;
}

function normalizeOpenAIRequest(body) {
  const messages = normalizeMessages(body.messages);
  const systemMessages = messages.filter((item) => item.role === "system");
  const nonSystemMessages = messages.filter((item) => item.role !== "system");
  const system = systemMessages.map((item) => item.text).join("\n\n");

  return {
    requestedModel: coerceModel(body.model),
    system,
    messages: nonSystemMessages,
    prompt: buildPrompt(system, nonSystemMessages),
    lastUserMessage: findLastMessage(nonSystemMessages, "user"),
    temperature: numberOrNull(body.temperature),
    maxTokens: numberOrNull(body.max_completion_tokens ?? body.max_tokens),
    metadata: {
      provider: "openai",
    },
  };
}

function normalizeAnthropicRequest(body) {
  const system = extractContentText(body.system ?? "");
  const messages = normalizeMessages(body.messages);

  return {
    requestedModel: coerceModel(body.model),
    system,
    messages,
    prompt: buildPrompt(system, messages),
    lastUserMessage: findLastMessage(messages, "user"),
    temperature: numberOrNull(body.temperature),
    maxTokens: numberOrNull(body.max_tokens),
    metadata: {
      provider: "anthropic",
      anthropicVersion: typeof body.anthropic_version === "string" ? body.anthropic_version : null,
    },
  };
}

function normalizeMessages(messages) {
  return messages.map((message, index) => {
    if (!message || typeof message !== "object") {
      throw new Error(`第 ${index + 1} 条消息不是对象`);
    }

    if (typeof message.role !== "string" || !message.role) {
      throw new Error(`第 ${index + 1} 条消息缺少 role`);
    }

    return {
      role: message.role,
      text: extractMessageText(message, index),
    };
  });
}

function extractMessageText(message, index) {
  if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    throw new Error(`第 ${index + 1} 条 assistant 消息包含 tool_calls，当前桥接层暂不支持`);
  }

  return extractContentText(message.content);
}

function extractContentText(content) {
  if (typeof content === "string") {
    return content;
  }

  if (content == null) {
    return "";
  }

  if (Array.isArray(content)) {
    const textParts = [];

    for (const item of content) {
      if (typeof item === "string") {
        textParts.push(item);
        continue;
      }

      if (!item || typeof item !== "object") {
        continue;
      }

      if (item.type === "text" && typeof item.text === "string") {
        textParts.push(item.text);
        continue;
      }

      if (item.type === "input_text" && typeof item.text === "string") {
        textParts.push(item.text);
        continue;
      }

      throw new Error(`暂不支持的消息内容类型: ${item.type ?? "unknown"}`);
    }

    return textParts.join("\n");
  }

  throw new Error("消息 content 只支持字符串或文本数组");
}

function buildPrompt(system, messages) {
  const parts = [];

  if (system) {
    parts.push(`系统指令：\n${system}`);
  }

  parts.push("下面是完整对话历史，请基于全部上下文回复最后一条用户消息。");

  for (const message of messages) {
    parts.push(`${renderRole(message.role)}：\n${message.text}`);
  }

  parts.push("请直接输出 assistant 的下一条回复正文，不要附加角色名。");

  return parts.join("\n\n");
}

function renderRole(role) {
  switch (role) {
    case "system":
      return "system";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
    default:
      return role;
  }
}

function findLastMessage(messages, role) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === role) {
      return messages[index].text;
    }
  }

  return "";
}

function extractAssistantText(callbackPayload) {
  if (typeof callbackPayload === "string") {
    return callbackPayload;
  }

  if (!callbackPayload || typeof callbackPayload !== "object") {
    throw new Error("Lindy 回调为空或格式不正确");
  }

  if (typeof callbackPayload.content === "string") {
    return callbackPayload.content;
  }

  if (typeof callbackPayload.text === "string") {
    return callbackPayload.text;
  }

  if (typeof callbackPayload.response === "string") {
    return callbackPayload.response;
  }

  if (typeof callbackPayload.assistant_response === "string") {
    return callbackPayload.assistant_response;
  }

  if (Array.isArray(callbackPayload.content)) {
    return extractContentText(callbackPayload.content);
  }

  if (
    Array.isArray(callbackPayload.choices) &&
    callbackPayload.choices[0] &&
    callbackPayload.choices[0].message &&
    typeof callbackPayload.choices[0].message.content === "string"
  ) {
    return callbackPayload.choices[0].message.content;
  }

  throw new Error(
    "Lindy 回调中未找到可识别的文本字段。请让回调至少返回 content / text / response 之一。",
  );
}

function extractOpenAIUsage(callbackPayload) {
  if (
    callbackPayload &&
    typeof callbackPayload === "object" &&
    callbackPayload.usage &&
    typeof callbackPayload.usage === "object" &&
    Number.isFinite(callbackPayload.usage.prompt_tokens) &&
    Number.isFinite(callbackPayload.usage.completion_tokens) &&
    Number.isFinite(callbackPayload.usage.total_tokens)
  ) {
    return callbackPayload.usage;
  }

  return null;
}

function extractAnthropicUsage(callbackPayload) {
  if (
    callbackPayload &&
    typeof callbackPayload === "object" &&
    callbackPayload.usage &&
    typeof callbackPayload.usage === "object" &&
    Number.isFinite(callbackPayload.usage.input_tokens) &&
    Number.isFinite(callbackPayload.usage.output_tokens)
  ) {
    return callbackPayload.usage;
  }

  return {
    input_tokens: 0,
    output_tokens: 0,
  };
}

function authorizeClient(req) {
  if (!config.bridgeApiKey) {
    return true;
  }

  const authHeader = req.headers.authorization;
  if (authHeader === `Bearer ${config.bridgeApiKey}`) {
    return true;
  }

  const apiKeyHeader = req.headers["x-api-key"];
  if (apiKeyHeader === config.bridgeApiKey) {
    return true;
  }

  return false;
}

async function readJson(req) {
  const rawText = await readBodyText(req);
  const text = rawText.trim();

  if (!text) {
    return {};
  }

  try {
    return parseJsonText(text);
  } catch (error) {
    throw new Error(`JSON 解析失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

async function readPreparePayload(req) {
  const rawText = await readBodyText(req);
  const text = rawText.trim();
  const contentType = readHeaderValue(req.headers["content-type"]).toLowerCase();

  if (!text) {
    return {};
  }

  if (isJsonContentType(contentType)) {
    return parseJsonText(text);
  }

  return parsePossibleJsonValue(rawText);
}

async function readCallbackPayload(req) {
  const rawText = await readBodyText(req);
  const text = rawText.trim();
  const contentType = readHeaderValue(req.headers["content-type"]).toLowerCase();
  const bodyLooksLikeJson = looksLikeJsonPayload(text);

  if (!text) {
    return {};
  }

  if (isTextContentType(contentType)) {
    return rawText;
  }

  if (isJsonContentType(contentType)) {
    try {
      return parseJsonText(text);
    } catch (error) {
      if (!bodyLooksLikeJson) {
        return rawText;
      }

      throw new Error(`回调请求体解析失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  if (bodyLooksLikeJson) {
    try {
      return parseJsonText(text);
    } catch {
      return rawText;
    }
  }

  return rawText;
}

async function readBodyText(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`请求体超过限制（${MAX_BODY_BYTES} bytes）`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const sanitizedText = sanitizeJsonControlCharacters(text);

    if (sanitizedText !== text) {
      return JSON.parse(sanitizedText);
    }

    throw error;
  }
}

function parsePossibleJsonValue(value) {
  if (typeof value !== "string") {
    return value;
  }

  const text = value.trim();
  if (!text || !looksLikeJsonPayload(text)) {
    return value;
  }

  try {
    return parseJsonText(text);
  } catch {
    return value;
  }
}

function sanitizeJsonControlCharacters(text) {
  let result = "";
  let inString = false;
  let isEscaping = false;
  let changed = false;

  for (const char of text) {
    if (inString) {
      if (isEscaping) {
        result += char;
        isEscaping = false;
        continue;
      }

      if (char === "\\") {
        result += char;
        isEscaping = true;
        continue;
      }

      if (char === "\"") {
        result += char;
        inString = false;
        continue;
      }

      const escapedChar = toEscapedControlCharacter(char);
      if (escapedChar) {
        result += escapedChar;
        changed = true;
        continue;
      }

      result += char;
      continue;
    }

    if (char === "\"") {
      inString = true;
    }

    result += char;
  }

  return changed ? result : text;
}

function toEscapedControlCharacter(char) {
  switch (char) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default: {
      const codePoint = char.codePointAt(0) ?? 0;
      if (codePoint < 0x20) {
        return `\\u${codePoint.toString(16).padStart(4, "0")}`;
      }
      return "";
    }
  }
}

function looksLikeJsonPayload(text) {
  return text.startsWith("{") || text.startsWith("[") || text.startsWith("\"");
}

function isJsonContentType(contentType) {
  return contentType.includes("application/json") || contentType.includes("+json");
}

function isTextContentType(contentType) {
  return contentType.startsWith("text/");
}

function readHeaderValue(value) {
  if (Array.isArray(value)) {
    return String(value[0] ?? "");
  }

  return typeof value === "string" ? value : "";
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, statusCode, text, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(text);
}

function sendOpenAIError(res, statusCode, message) {
  const type =
    statusCode === 401
      ? "authentication_error"
      : statusCode >= 500
        ? "api_error"
        : "invalid_request_error";

  return sendJson(res, statusCode, {
    error: {
      message,
      type,
    },
  });
}

function sendAnthropicError(res, statusCode, message) {
  const type =
    statusCode === 401
      ? "authentication_error"
      : statusCode >= 500
        ? "api_error"
        : "invalid_request_error";

  return sendJson(
    res,
    statusCode,
    {
      type: "error",
      error: {
        type,
        message,
      },
    },
    {
      "anthropic-version": "2023-06-01",
    },
  );
}

function classifyErrorStatus(error) {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("未授权")) {
    return 401;
  }

  if (message.includes("超时")) {
    return 504;
  }

  if (
    message.includes("JSON 解析失败") ||
    message.includes("请求体超过限制") ||
    message.includes("messages") ||
    message.includes("缺少 role") ||
    message.includes("content") ||
    message.includes("暂不支持") ||
    message.includes("不是对象")
  ) {
    return 400;
  }

  if (
    message.includes("调用 Lindy webhook 失败") ||
    message.includes("回调请求体解析失败") ||
    message.includes("Lindy 回调") ||
    message.includes("fetch failed")
  ) {
    return 502;
  }

  return 500;
}

function buildCallbackUrl(jobId) {
  const base = new URL(`/__lindy/callback/${jobId}`, config.publicBaseUrl);
  if (config.callbackToken) {
    base.searchParams.set("token", config.callbackToken);
  }
  return base.toString();
}

function buildStaticCallbackUrl() {
  const base = new URL("/__lindy/callback", config.publicBaseUrl);
  if (config.callbackToken) {
    base.searchParams.set("token", config.callbackToken);
  }
  return base.toString();
}

function listModels(routes) {
  const names = Object.keys(routes);
  if (!names.includes("default")) {
    return names;
  }
  if (names.length === 1) {
    return ["default"];
  }
  return names;
}

function pickRoute(routes, requestedModel) {
  if (routes[requestedModel]) {
    return routes[requestedModel];
  }

  if (routes.default) {
    return routes.default;
  }

  throw new Error(`未找到模型 ${requestedModel} 的 Lindy 路由`);
}

function loadConfig() {
  const port = parseInteger(process.env.PORT, 8787);
  const publicBaseUrl = requiredEnv("PUBLIC_BASE_URL");
  const requestTimeoutMs = parseInteger(process.env.REQUEST_TIMEOUT_MS, 120000);

  return {
    port,
    publicBaseUrl,
    bridgeApiKey: process.env.BRIDGE_API_KEY?.trim() || "",
    callbackToken: process.env.LINDY_CALLBACK_TOKEN?.trim() || "",
    requestTimeoutMs,
    routes: loadRoutes(),
  };
}

function loadEnvFiles() {
  const envFiles = [".env", ".env.local"];

  for (const filename of envFiles) {
    const absolutePath = join(process.cwd(), filename);

    if (!existsSync(absolutePath)) {
      continue;
    }

    const content = readFileSync(absolutePath, "utf8");
    applyEnvText(content);
  }
}

function applyEnvText(content) {
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function loadRoutes() {
  if (process.env.LINDY_ROUTES?.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(process.env.LINDY_ROUTES);
    } catch (error) {
      throw new Error(`LINDY_ROUTES 不是合法 JSON: ${error instanceof Error ? error.message : "未知错误"}`);
    }

    const routes = {};
    for (const [name, value] of Object.entries(parsed)) {
      routes[name] = normalizeRoute(name, value);
    }
    return routes;
  }

  return {
    default: normalizeRoute("default", {
      webhookUrl: requiredEnv("LINDY_WEBHOOK_URL"),
      webhookSecret: process.env.LINDY_WEBHOOK_SECRET?.trim() || "",
    }),
  };
}

function normalizeRoute(name, value) {
  if (!value || typeof value !== "object") {
    throw new Error(`路由 ${name} 配置无效`);
  }

  if (typeof value.webhookUrl !== "string" || !value.webhookUrl.trim()) {
    throw new Error(`路由 ${name} 缺少 webhookUrl`);
  }

  return {
    name,
    webhookUrl: value.webhookUrl.trim(),
    webhookSecret: typeof value.webhookSecret === "string" ? value.webhookSecret.trim() : "",
    timeoutMs: parseRouteTimeout(value.timeoutMs),
  };
}

function parseRouteTimeout(value) {
  if (Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少环境变量 ${name}`);
  }
  return value;
}

function parseInteger(rawValue, fallback) {
  const value = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function coerceModel(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return "default";
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function isMainModule() {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }

  return fileURLToPath(import.meta.url) === entryPath;
}

if (isMainModule()) {
  await startBridgeServer();
}
