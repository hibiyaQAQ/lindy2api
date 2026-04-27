import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.BRIDGE_API_KEY || "bridge-dev-key",
  baseURL: process.env.ANTHROPIC_BASE_URL || "http://127.0.0.1:8787",
});

const message = await client.messages.create({
  model: process.env.ANTHROPIC_MODEL || "default",
  max_tokens: 512,
  system: "你是一个严谨的中文助手。",
  messages: [
    {
      role: "user",
      content: "请用一句话说明这个桥接层的作用。",
    },
  ],
});

const firstBlock = message.content.find((block) => block.type === "text");
console.log(firstBlock?.text ?? "");
