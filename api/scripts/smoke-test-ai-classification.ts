import { classifyWithOpenRouter } from "../src/ai-classification.js";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");

const results = await classifyWithOpenRouter(
  {
    apiKey,
    model: process.env.OPENROUTER_MODEL ?? "openai/gpt-5.4-nano",
    webOrigin: process.env.WEB_ORIGIN ?? "https://tracestack.gg",
  },
  "error",
  [{
    id: "00000000-0000-4000-8000-000000000001",
    type: "error",
    message:
      "DataStore request was throttled for key PLAYER_<ID>; retrying.",
    severity: "warning",
    side: "server",
    source: "ServerScriptService.Data",
  }],
);

console.log(JSON.stringify(results));
