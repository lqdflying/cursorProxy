import assert from "node:assert/strict";
import handler from "../api/proxy.js";
import { setKvDriver } from "../api/kv.js";

process.env.AZURE_FOUNDRY_API_KEY = process.env.AZURE_FOUNDRY_API_KEY || "test";
process.env.AZURE_FOUNDRY_RESOURCE = process.env.AZURE_FOUNDRY_RESOURCE || "test-resource";

const kv = new Map();
setKvDriver({
  get: async (key) => kv.get(key) ?? null,
  set: async (key, value) => {
    kv.set(key, value);
  },
});

const captures = [];
const logs = [];
const originalFetch = globalThis.fetch;
const originalLog = console.log;
let nextUpstream;

console.log = (...args) => {
  logs.push(args.join(" "));
};

globalThis.fetch = async (url, init = {}) => {
  if (init.body) {
    const body = JSON.parse(init.body);
    assert.ok(
      Object.prototype.hasOwnProperty.call(body, "input") ||
      Object.prototype.hasOwnProperty.call(body, "prompt"),
      "Azure request emitted without input or prompt"
    );
    captures.push({ url: String(url), body });
  }
  assert.equal(typeof nextUpstream, "function", "nextUpstream mock not configured");
  return nextUpstream(url, init);
};

function reset() {
  captures.length = 0;
  logs.length = 0;
  nextUpstream = null;
}

function request(body) {
  return new Request("https://local/api/proxy?provider=azureopenai&path=chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function completedResponse(id, text = "ok") {
  return new Response(JSON.stringify({
    id,
    status: "completed",
    model: "gpt-5.5",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function sseResponse(text) {
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function call(body, upstream) {
  nextUpstream = upstream;
  const res = await handler(request(body));
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return text;
}

try {
  reset();
  await call({
    model: "gpt-5.5",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ],
  }, () => completedResponse("resp_legacy"));
  assert.equal(captures[0].body.messages, undefined);
  assert.equal(captures[0].body.instructions, "sys");
  assert.equal(captures[0].body.input.length, 1);
  assert.ok(logs.some((line) => line.includes("MESSAGES_TO_INPUT")));

  reset();
  await call({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "tools" }],
    include: ["message.output_text.logprobs"],
    background: true,
    text: { format: { type: "json_object" } },
    truncation: "auto",
    tools: [
      { type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object" } } },
      { type: "mcp", server_label: "docs", server_url: "https://mcp.example.test" },
      { type: "image_generation" },
      null,
      { nope: true },
    ],
  }, () => completedResponse("resp_tools"));
  assert.equal(captures[0].body.background, true);
  assert.equal(captures[0].body.store, true);
  assert.deepEqual(captures[0].body.include, ["message.output_text.logprobs"]);
  assert.equal(captures[0].body.text.format.type, "json_object");
  assert.equal(captures[0].body.truncation, "auto");
  assert.deepEqual(captures[0].body.tools.map((tool) => tool.type), ["function", "mcp", "image_generation"]);
  assert.equal(captures[0].body.tools[0].name, "lookup");

  reset();
  await call({
    model: "gpt-5.5",
    prompt: {
      id: "pmpt_test",
      variables: { topic: "compatibility" },
    },
    background: true,
    prompt_cache_retention: "24h",
  }, () => completedResponse("resp_prompt"));
  assert.equal(captures[0].body.input, undefined);
  assert.equal(captures[0].body.prompt.id, "pmpt_test");
  assert.equal(captures[0].body.background, true);
  assert.equal(captures[0].body.store, true);
  assert.equal(captures[0].body.prompt_cache_retention, "24h");

  reset();
  await call({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "versioned tool" }],
    tools: [
      { type: "bash_20250124", name: "run_command", description: "Run command", input_schema: { type: "object" } },
      { type: "custom", name: "freeform", description: "Native custom tool", input_schema: { type: "object" } },
      { type: "custom", name: "freeform_text", description: "Native custom text tool", format: { type: "text" } },
    ],
  }, () => completedResponse("resp_versioned_tool"));
  assert.deepEqual(captures[0].body.tools.map((tool) => tool.type), ["function", "function", "function"]);
  assert.equal(captures[0].body.tools[0].name, "run_command");
  assert.deepEqual(captures[0].body.tools[0].parameters, { type: "object" });
  assert.equal(captures[0].body.tools[0].input_schema, undefined);
  assert.equal(captures[0].body.tools[1].name, "freeform");
  assert.deepEqual(captures[0].body.tools[1].parameters, { type: "object" });
  assert.equal(captures[0].body.tools[1].input_schema, undefined);
  assert.equal(captures[0].body.tools[2].name, "freeform_text");
  assert.equal(captures[0].body.tools[2].format, undefined);
  assert.equal(captures[0].body.tools[2].parameters.properties.input.type, "string");

  reset();
  const incompleteText = await call({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "short" }],
  }, () => new Response(JSON.stringify({
    id: "resp_incomplete",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    model: "gpt-5.5",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "partial" }],
    }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  assert.equal(JSON.parse(incompleteText).choices[0].finish_reason, "length");

  reset();
  const streamText = await call({
    model: "gpt-5.5",
    stream: true,
    messages: [{ role: "user", content: "stream" }],
  }, () => sseResponse([
    "event: response.created\n",
    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stream\",\"status\":\"in_progress\",\"model\":\"gpt-5.5\"}}\n\n",
    "event: response.output_text.delta\n",
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n",
    "event: response.incomplete\n",
    "data: {\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_stream\",\"status\":\"incomplete\",\"model\":\"gpt-5.5\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n",
  ].join("")));
  assert.match(streamText, /"finish_reason":"length"/);
  assert.match(streamText, /data: \[DONE\]/);

  reset();
  await call({
    model: "gpt-5.5",
    messages: [
      { role: "user", content: "miss one" },
      { role: "assistant", content: "miss answer" },
      { role: "user", content: "miss two" },
    ],
  }, () => completedResponse("resp_chain_miss"));
  assert.equal(captures[0].body.previous_response_id, undefined);
  assert.ok(logs.some((line) => line.includes("PREV_RESP_ID_MISS")));

  reset();
  await call({
    model: "gpt-5.5",
    messages: [
      { role: "system", content: "chain sys" },
      { role: "user", content: "one" },
    ],
  }, () => completedResponse("resp_chain_messages"));
  await call({
    model: "gpt-5.5",
    messages: [
      { role: "system", content: "chain sys" },
      { role: "user", content: "one" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "two" },
    ],
  }, () => completedResponse("resp_chain_messages_2"));
  assert.equal(captures[1].body.previous_response_id, "resp_chain_messages");
  assert.equal(captures[1].body.instructions, "chain sys");
  assert.equal(captures[1].body.input.length, 1);
  assert.ok(logs.some((line) => line.includes("PREV_RESP_ID_FOUND")));
  assert.ok(logs.some((line) => line.includes("MESSAGES_TO_INPUT")));

  reset();
  await call({
    model: "gpt-5.5",
    messages: [
      { role: "system", content: "chain sys" },
      { role: "user", content: "one" },
      { role: "assistant", content: "answer" },
    ],
  }, () => completedResponse("resp_empty_trim"));
  assert.equal(captures[0].body.previous_response_id, undefined);
  assert.equal(captures[0].body.instructions, "chain sys");
  assert.ok(captures[0].body.input.length > 0);
  assert.ok(logs.some((line) => line.includes("INPUT_CHAIN_EMPTY_TRIM")));

  reset();
  await call({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "native sys" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] },
    ],
  }, () => completedResponse("resp_chain_input"));
  await call({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "native sys" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "two" }] },
    ],
  }, () => completedResponse("resp_chain_input_2"));
  assert.equal(captures[1].body.previous_response_id, "resp_chain_input");
  assert.equal(captures[1].body.instructions, "native sys");
  assert.equal(captures[1].body.input.length, 1);
  assert.ok(logs.some((line) => line.includes("INPUT_CHAIN")));

  reset();
  await call({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "search one" }] },
    ],
  }, () => completedResponse("resp_chain_builtin"));
  await call({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "search one" }] },
      { type: "web_search_call", id: "ws_1", status: "completed" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "search answer" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "search two" }] },
    ],
  }, () => completedResponse("resp_chain_builtin_2"));
  assert.equal(captures[1].body.previous_response_id, "resp_chain_builtin");
  assert.equal(captures[1].body.input.length, 1);

  originalLog("azure-openai replay checks passed");
} finally {
  console.log = originalLog;
  globalThis.fetch = originalFetch;
}
