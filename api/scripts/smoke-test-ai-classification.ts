import { classifyWithOpenRouter } from "../src/ai-classification.js";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");

const syntheticMessages = [
  "DataStore request was throttled for key PLAYER_<ID>; retrying.",
  "Failed to play animation <ID>: track limit exceeded.",
  "MarketplaceService price lookup timed out for product <ID>.",
  "Player joined server.",
];
const results = await classifyWithOpenRouter(
  {
    apiKey,
    model: process.env.OPENROUTER_MODEL ?? "openai/gpt-5.4-nano",
    webOrigin: process.env.WEB_ORIGIN ?? "https://tracestack.gg",
  },
  "error",
  Array.from({ length: 32 }, (_, key) => ({
    id: `00000000-0000-4000-8000-${String(key + 1).padStart(12, "0")}`,
    type: "error",
    message: syntheticMessages[key % syntheticMessages.length]!,
    severity: key % 4 === 3 ? "info" : "warning",
    side: "server",
    source: "ServerScriptService.Data",
  })),
);

console.log(JSON.stringify({
  count: results.length,
  categories: results.reduce<Record<string, number>>((counts, result) => {
    counts[result.category] = (counts[result.category] ?? 0) + 1;
    return counts;
  }, {}),
}));
