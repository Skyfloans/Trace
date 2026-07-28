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
  const responseFormat = requestBody?.response_format as {
    json_schema: {
      schema: { properties: { results: { minItems: number; maxItems: number } } };
    };
  };
  assert.equal(
    responseFormat.json_schema.schema.properties.results.minItems,
    1,
  );
  assert.equal(
    responseFormat.json_schema.schema.properties.results.maxItems,
    1,
  );
  assert.match(messages[1]?.content ?? "", /one for every key/);
});

test("feedback classification translates non-English text and requires useful critique", async () => {
  let responseSchema: unknown;
  let systemMessage = "";
  let userMessage = "";
  const results = await classifyWithOpenRouter(
    {
      apiKey: "test-openrouter-key-that-is-long-enough",
      model: "openai/gpt-5.4-nano",
      webOrigin: "https://tracestack.gg",
      fetchImplementation: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        responseSchema = body.response_format;
        systemMessage = body.messages[0].content;
        userMessage = body.messages[1].content;
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: `Here is the requested JSON:
\`\`\`json
${JSON.stringify({
                results: [{
                  key: 0,
                  category: "suggestion",
                  confidence: 0.88,
                  reason: "Requests a new inventory search feature.",
                  translated: true,
                  translated_message: "Please add a search box to the inventory.",
                }],
              })}
\`\`\``,
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
    "feedback",
    [{
      id: "20000000-0000-4000-8000-000000000001",
      type: "feedback",
      message: "Por favor, adicione uma busca ao inventário.",
    }],
  );

  const serialized = JSON.stringify(responseSchema);
  assert.match(serialized, /bug_report/);
  assert.match(serialized, /critique/);
  assert.match(serialized, /suggestion/);
  assert.match(serialized, /general/);
  assert.match(serialized, /translated_message/);
  assert.doesNotMatch(serialized, /critical/);
  assert.match(systemMessage, /unproductive negativity/);
  assert.match(systemMessage, /this is so ugly/);
  assert.match(userMessage, /translate it into natural English/);
  assert.match(userMessage, /Do not name or include the original language/);
  assert.equal(results[0]?.translated, true);
  assert.equal(
    results[0]?.translatedMessage,
    "Please add a search box to the inventory.",
  );
});
