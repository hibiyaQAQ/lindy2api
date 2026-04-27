import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.BRIDGE_API_KEY || "bridge-dev-key",
  baseURL: process.env.OPENAI_BASE_URL || "http://127.0.0.1:8787/v1",
});

const completion = await client.chat.completions.create({
  model: process.env.OPENAI_MODEL || "default",
  messages: [
    {
      role: "system",
      content: "你是一个严谨的中文助手。",
    },
    {
      role: "user",
      content: "请用一句话说明这个桥接层的作用。",
    },
  ],
});

console.log(completion.choices[0]?.message?.content ?? "");
