import assert from "node:assert/strict";
import test from "node:test";
import { classifyWithOpenRouter } from "../src/ai-classification.js";

test("OpenRouter classification uses the Roblox Luau rubric and strict output", async () => {
  let requestBody: Record<string, unknown> | null = null;
  const result = await classifyWithOpenRouter(
    {
      apiKey: "test-openrouter-key-that-is-long-enough",
      model: "openai/gpt-5.4-nano",
      webOrigin: "https://tracestack.gg",
      fetchImplementation: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                results: [{
                  key: 0,
                  category: "medium",
                  confidence: 0.91,
                  reason: "Actionable DataStore throttling with limited impact.",
                }],
              }),
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
    "error",
    [{
      id: "10000000-0000-4000-8000-000000000001",
      type: "error",
      message: "DataStore request was added to queue. Key = PLAYER_<ID>",
      severity: "warning",
      side: "server",
      source: "DataService",
    }],
  );

  assert.equal(result[0]?.category, "medium");
  assert.equal(requestBody?.model, "openai/gpt-5.4-nano");
  const messages = requestBody?.messages as Array<{ content: string }>;
  assert.match(messages[0]?.content ?? "", /Roblox and Luau/);
  assert.match(messages[0]?.content ?? "", /DataStoreService/);
  assert.deepEqual(
    (requestBody?.response_format as { type: string }).type,
    "json_schema",
  );
});

test("feedback classification only permits product-signal categories", async () => {
  let responseSchema: unknown;
  await classifyWithOpenRouter(
    {
      apiKey: "test-openrouter-key-that-is-long-enough",
      model: "openai/gpt-5.4-nano",
      webOrigin: "https://tracestack.gg",
      fetchImplementation: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        responseSchema = body.response_format;
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                results: [{
                  key: 0,
                  category: "suggestion",
                  confidence: 0.88,
                  reason: "Requests a new inventory search feature.",
                }],
              }),
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
    "feedback",
    [{
      id: "20000000-0000-4000-8000-000000000001",
      type: "feedback",
      message: "Please add a search box to the inventory.",
    }],
  );

  const serialized = JSON.stringify(responseSchema);
  assert.match(serialized, /bug_report/);
  assert.match(serialized, /critique/);
  assert.match(serialized, /suggestion/);
  assert.match(serialized, /general/);
  assert.doesNotMatch(serialized, /critical/);
});
