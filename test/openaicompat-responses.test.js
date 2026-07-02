import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/proxy.js";
import {
  mapResponsesSSEToOpenAI,
  normalizeAzureOpenAIInputContent,
  normalizeOpenAICompatResponsesInputContent,
} from "../lib/azure-openai.js";
import { setKvDriver } from "../lib/kv.js";

// These tests invoke the shared handler directly with the internal rewrite
// URL shape (/api/proxy?provider=openaicompat&path=chat/completions). They
// exercise the request transformation + KV chaining but do NOT test server.js,
// vercel.json, or the EdgeOne rewrite adapters.

const PROVIDER_URL = "http://localhost/api/proxy?provider=openaicompat&path=chat/completions";

const ENV_KEYS = [
  "OPENAICOMPAT_WIRE_API",
  "OPENAICOMPAT_API_KEY",
  "UPSTREAM_OPENAICOMPAT",
  "CURSORPROXY_API_KEY",
];

// Minimal in-memory KV map with a Redis-like driver shape
// ({ get, set(key, value, "EX", ttl) }) so setKvDriver() picks it up.
function makeInMemoryKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async set(key, value) { store.set(key, value); },
  };
}

describe("openaicompat Responses wire mode — integration", () => {
  let origFetch;
  let origEnvs = {};

  beforeEach(() => {
    origFetch = global.fetch;
    origEnvs = {};
    for (const k of ENV_KEYS) origEnvs[k] = process.env[k];
    process.env.OPENAICOMPAT_API_KEY = "sk-test-key";
    process.env.UPSTREAM_OPENAICOMPAT = "https://api.openai.com";
    delete process.env.CURSORPROXY_API_KEY; // avoid auth requirement in tests
  });

  afterEach(() => {
    global.fetch = origFetch;
    for (const k of ENV_KEYS) {
      if (origEnvs[k] === undefined) delete process.env[k];
      else process.env[k] = origEnvs[k];
    }
    // Reset the KV driver so tests don't leak state into each other.
    setKvDriver(null);
  });

  // Helper: mock fetch to return a Responses-API-shaped JSON body and capture
  // the outbound URL + body for assertions.
  function mockFetchResponses(responsesBody) {
    let captured = { url: null, body: null };
    global.fetch = async (url, init) => {
      captured.url = url;
      captured.body = JSON.parse(init.body);
      return new Response(JSON.stringify(responsesBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    return captured;
  }

  // ─── Default (chat mode): no Responses remap ────────────────────────────

  it("default chat mode posts to /v1/chat/completions (no remap)", async () => {
    delete process.env.OPENAICOMPAT_WIRE_API;
    const captured = mockFetchResponses({
      id: "chat_abc",
      object: "chat.completion",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    });

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    }));

    assert.equal(res.status, 200);
    assert.ok(captured.url.endsWith("/v1/chat/completions"), `expected chat/completions, got: ${captured.url}`);
    // In chat mode, messages stays as messages (not converted to input)
    assert.ok(captured.body.messages, "chat mode should keep messages array");
    assert.equal(captured.body.input, undefined, "chat mode should not produce input");
  });

  // ─── Responses mode: URL remap ──────────────────────────────────────────

  it("responses mode remaps chat/completions → responses in the URL", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const captured = mockFetchResponses({
      id: "resp_abc",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    }));

    assert.equal(res.status, 200);
    assert.ok(captured.url.endsWith("/v1/responses"), `expected responses, got: ${captured.url}`);
    assert.ok(!captured.url.includes("/v1/v1/"), `double /v1 prefix: ${captured.url}`);
  });

  it("responses mode does NOT remap non-chat/completions paths (e.g. embeddings)", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    let capturedUrl = null;
    let capturedBody = null;
    global.fetch = async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await handler(new Request("http://localhost/api/proxy?provider=openaicompat&path=embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: "test",
        encoding_format: "float",
        dimensions: 256,
      }),
    }));

    assert.ok(capturedUrl, "fetch should have been called");
    assert.ok(capturedUrl.endsWith("/v1/embeddings"), `expected /v1/embeddings, got: ${capturedUrl}`);
    // Regression for path-gate bug: Responses-mode sanitization must NOT touch
    // non-chat/completions paths. encoding_format and dimensions are not in
    // the Responses API whitelist but must survive for /embeddings.
    assert.equal(capturedBody.encoding_format, "float", "encoding_format must survive (not whitelisted)");
    assert.equal(capturedBody.dimensions, 256, "dimensions must survive (not whitelisted)");
    assert.equal(capturedBody.store, undefined, "store:false must NOT be injected for /embeddings");
    assert.equal(capturedBody.input, "test", "input must stay as-is");
  });

  // ─── UPSTREAM_OPENAICOMPAT normalization ─────────────────────────────────

  it("tolerates trailing /v1 in UPSTREAM_OPENAICOMPAT (no double prefix)", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.UPSTREAM_OPENAICOMPAT = "https://api.openai.com/v1";
    const captured = mockFetchResponses({
      id: "resp_abc", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    }));

    assert.ok(captured.url.includes("://api.openai.com/v1/responses"), `unexpected URL: ${captured.url}`);
    assert.ok(!captured.url.includes("/v1/v1/"), `double /v1: ${captured.url}`);
  });

  // ─── Messages → input conversion (MESSAGES_TO_INPUT branch) ─────────────

  it("responses mode converts messages to input and injects store:true", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const captured = mockFetchResponses({
      id: "resp_abc", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
      }),
    }));

    // messages should be gone, replaced by input
    assert.equal(captured.body.messages, undefined, "messages should be deleted");
    assert.ok(Array.isArray(captured.body.input), "input should be an array");
    assert.equal(captured.body.input[0].role, "user");
    assert.equal(captured.body.input[0].content, "hello",
      "openaicompat Responses must preserve string content for compatible gateways");
    assert.equal(Array.isArray(captured.body.input[0].content), false,
      "openaicompat Responses must not convert text into Azure input_text parts");
    assert.equal(captured.body.store, true, "store:true must be injected for chaining");
    // previous_response_id absent on first turn (no cache hit)
    assert.equal(captured.body.previous_response_id, undefined);
  });

  it("responses mode converts array text parts to input_text without changing string content", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const captured = mockFetchResponses({
      id: "resp_abc", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are concise." },
          { role: "assistant", content: [{ type: "text", text: "prior" }] },
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
      }),
    }));

    assert.equal(captured.body.input[0].content, "You are concise.",
      "plain string content should stay string for compatible gateways");
    assert.deepEqual(captured.body.input[1].content, [{ type: "output_text", text: "prior" }]);
    assert.deepEqual(captured.body.input[2].content, [{ type: "input_text", text: "hello" }]);
  });

  it("responses mode converts assistant.tool_calls and role:tool in messages", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const captured = mockFetchResponses({
      id: "resp_abc", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
    });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "user", content: "list files" },
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "list", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_1", content: "file.txt" },
        ],
      }),
    }));

    // The assistant tool_call should become a function_call item,
    // and the tool result should become a function_call_output item.
    const types = captured.body.input.map((i) => i.type);
    assert.ok(types.includes("function_call"), `expected function_call in: ${JSON.stringify(types)}`);
    assert.ok(types.includes("function_call_output"), `expected function_call_output in: ${JSON.stringify(types)}`);
  });

  it("responses mode retries mixed function/custom tools without native custom tools after upstream 5xx", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          error: { message: "Upstream request failed", type: "upstream_error" },
        }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        id: "resp_retry",
        object: "response",
        model: "gpt-4o",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "function",
            function: {
              name: "noop",
              description: "No operation.",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
          },
          {
            type: "custom",
            name: "apply_patch",
            description: "Apply patch.",
            format: { type: "text" },
          },
        ],
      }),
    }));

    assert.equal(res.status, 200);
    assert.equal(calls.length, 2, "mixed tool 5xx should be retried once");
    assert.equal(calls[0].body.tools.filter((t) => t.type === "custom").length, 1,
      "first request should preserve official mixed Responses tools");
    assert.equal(calls[1].body.tools.filter((t) => t.type === "custom").length, 0,
      "retry should not send native custom tools");
    assert.equal(calls[1].body.tools.filter((t) => t.type === "function").length, 1,
      "retry should preserve existing function tools");
    assert.equal(calls[1].body.tools.some((t) => t.name === "apply_patch"), false,
      "retry should drop apply_patch custom tool after the upstream rejects mixed tools");
  });

  // ─── Native input branch (INPUT_CHAIN) ───────────────────────────────────

  it("responses mode preserves native input array as-is on first turn", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const captured = mockFetchResponses({
      id: "resp_abc", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    const nativeInput = [
      { role: "user", content: "hello" },
    ];

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: nativeInput }),
    }));

    assert.ok(Array.isArray(captured.body.input), "native input should stay as input");
    assert.equal(captured.body.input.length, 1, "first-turn input should not be trimmed");
    assert.deepEqual(captured.body.input, nativeInput,
      "native openaicompat Responses input should not be Azure-normalized");
    assert.equal(captured.body.store, true);
    assert.equal(captured.body.previous_response_id, undefined);
  });

  // ─── Provider-specific content normalization guard ──────────────────────

  it("does not Azure-normalize openaicompat Responses string content", () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const parsedBody = { input: [{ role: "user", content: "hello" }] };

    const result = normalizeAzureOpenAIInputContent("openaicompat", parsedBody);

    assert.equal(result.changed, false);
    assert.deepEqual(parsedBody.input, [{ role: "user", content: "hello" }]);
  });

  it("openaicompat Responses normalizer preserves strings but fixes array text parts", () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const parsedBody = {
      input: [
        { role: "system", content: "keep string" },
        { role: "user", content: [{ type: "text", text: "fix me" }] },
      ],
    };

    const result = normalizeOpenAICompatResponsesInputContent("openaicompat", parsedBody);

    assert.equal(result.changed, true);
    assert.equal(parsedBody.input[0].content, "keep string");
    assert.deepEqual(parsedBody.input[1].content, [{ type: "input_text", text: "fix me" }]);
  });

  it("still Azure-normalizes azureopenai string content to input_text", () => {
    const parsedBody = { input: [{ role: "user", content: "hello" }] };

    const result = normalizeAzureOpenAIInputContent("azureopenai", parsedBody);

    assert.equal(result.changed, true);
    assert.deepEqual(parsedBody.input, [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    }]);
  });

  // ─── store:false opt-out ─────────────────────────────────────────────────

  it("responses mode honors explicit store:false (no store injection)", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const captured = mockFetchResponses({
      id: "resp_abc", object: "response", model: "gpt-4o", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        store: false,
      }),
    }));

    assert.equal(captured.body.store, false, "explicit store:false must be honored");
  });

  it("responses mode rejects store:false + background:true with 400", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return new Response("{}", { status: 200 }); };

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        store: false,
        background: true,
      }),
    }));

    assert.equal(res.status, 400);
    assert.equal(fetchCalled, false, "upstream fetch must not be called on 400");
    const body = await res.json();
    assert.equal(body.error.code, "store_background_conflict");
  });

  // ─── Responses → Chat Completions response mapping ───────────────────────

  it("surfaces Responses stream error events instead of returning an empty completion", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const stream = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_err\",\"status\":\"in_progress\",\"model\":\"gpt-4o\"}}",
      "",
      "event: error",
      "data: {\"type\":\"error\",\"message\":\"provider stream failed\",\"code\":\"bad_gateway\"}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_err\",\"status\":\"completed\",\"error\":null}}",
      "",
    ].join("\n");
    global.fetch = async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }),
    }));

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const body = await res.text();
    assert.match(body, /provider stream failed/);
    assert.match(body, /bad_gateway/);
    assert.match(body, /data: \[DONE\]/);
    assert.equal(body.includes("STREAM_DONE_VIA_RESPONSE_COMPLETED"), false);
  });

  it("streams Responses function calls with dense Chat tool indexes and tool_calls finish reason", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const stream = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_tool\",\"status\":\"in_progress\",\"model\":\"gpt-4o\"}}",
      "",
      "event: response.output_item.added",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\"}}",
      "",
      "event: response.output_item.added",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":2,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_subagent\",\"name\":\"start_subagent\"}}",
      "",
      "event: response.function_call_arguments.delta",
      "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":2,\"item_id\":\"fc_1\",\"delta\":\"{\\\"task\\\":\"}",
      "",
      "event: response.function_call_arguments.delta",
      "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":2,\"item_id\":\"fc_1\",\"delta\":\"\\\"inspect\\\"}\"}",
      "",
      "event: response.function_call_arguments.done",
      "data: {\"type\":\"response.function_call_arguments.done\",\"output_index\":2,\"item_id\":\"fc_1\",\"arguments\":\"{\\\"task\\\":\\\"inspect\\\"}\"}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_tool\",\"status\":\"completed\",\"error\":null}}",
      "",
    ].join("\n");
    global.fetch = async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "start subagent" }], stream: true }),
    }));

    assert.equal(res.status, 200);
    const chunks = (await res.text())
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const toolChunks = chunks.filter((chunk) => chunk.choices?.[0]?.delta?.tool_calls);
    assert.ok(toolChunks.length >= 2, "expected streamed tool call chunks");
    assert.equal(toolChunks[0].choices[0].delta.tool_calls[0].index, 0,
      "Responses output_index must be remapped to dense Chat tool index 0");
    assert.equal(toolChunks[0].choices[0].delta.tool_calls[0].function.name, "start_subagent");
    assert.equal(toolChunks[1].choices[0].delta.tool_calls[0].index, 0,
      "argument deltas must keep the same dense Chat tool index");
    assert.ok(chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "tool_calls"),
      "stream must finish with finish_reason=tool_calls so Cursor runs the tool");
  });

  it("maps Responses output indexes to dense Chat tool indexes", () => {
    const state = new Map();
    const first = mapResponsesSSEToOpenAI("response.output_item.added", {
      output_index: 2,
      item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "first_tool" },
    }, state);
    const second = mapResponsesSSEToOpenAI("response.output_item.added", {
      output_index: 5,
      item: { id: "fc_2", type: "function_call", call_id: "call_2", name: "second_tool" },
    }, state);
    const firstDelta = mapResponsesSSEToOpenAI("response.function_call_arguments.delta", {
      output_index: 2,
      item_id: "fc_1",
      delta: "{}",
    }, state);

    assert.equal(first.choices[0].delta.tool_calls[0].index, 0);
    assert.equal(second.choices[0].delta.tool_calls[0].index, 1);
    assert.equal(firstDelta.choices[0].delta.tool_calls[0].index, 0);
  });

  it("maps Responses output to Chat Completions choices in the response", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    mockFetchResponses({
      id: "resp_abc",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello from Responses API" }],
      }],
    });

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    }));

    assert.equal(res.status, 200);
    const body = await res.json();
    // mapResponsesToOpenAI should produce choices[0].message.content
    assert.ok(body.choices, "response should have choices array");
    assert.equal(body.choices[0].message.content, "Hello from Responses API");
  });

  // ─── Alias path: compatible-gpt-5.5 ─────────────────────────────────────

  it("compatible-gpt-5.5 alias routes to openaicompat and maps response model back", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    mockFetchResponses({
      id: "resp_abc",
      object: "response",
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    const res = await handler(new Request("http://localhost/api/proxy?path=chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "cursorproxy/compatible-gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      }),
    }));

    assert.equal(res.status, 200);
    const body = await res.json();
    // Response model should reflect the public alias, not the upstream gpt-5.5
    assert.equal(body.model, "cursorproxy/compatible-gpt-5.5");
  });

  // ─── KV cache-hit chaining (two-turn end-to-end) ──────────────────────────

  it("falls back to stateless mode when upstream rejects HTTP previous_response_id", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.UPSTREAM_OPENAICOMPAT = "https://api.openai.com/prev-unsupported";
    const kv = makeInMemoryKv();
    setKvDriver(kv);
    const model = "gpt-prev-unsupported-test";

    global.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.previous_response_id, undefined, "turn 1 should be stateless");
      return new Response(JSON.stringify({
        id: "resp_abc",
        object: "response",
        model,
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    }));

    const oairespKeys = [...kv.store.keys()].filter((k) => k.startsWith("oairesp:"));
    assert.equal(oairespKeys.length, 1, "turn 1 should cache resp_abc");
    assert.equal(kv.store.get(oairespKeys[0]), "resp_abc");

    const turn2Calls = [];
    global.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      turn2Calls.push(body);
      if (turn2Calls.length === 1) {
        return new Response(JSON.stringify({
          error: {
            message: "previous_response_id is only supported on Responses WebSocket v2",
            type: "invalid_request_error",
          },
        }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        id: "resp_def",
        object: "response",
        model,
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "bye" }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const turn2Messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: [{ type: "text", text: "bye" }] },
    ];
    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: turn2Messages }),
    }));

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].message.content, "bye");
    assert.equal(turn2Calls.length, 2, "400 previous_response_id rejection should retry once");
    assert.equal(turn2Calls[0].previous_response_id, "resp_abc",
      "first turn 2 attempt should use the cached previous_response_id");
    assert.equal(turn2Calls[0].input.length, 1,
      "first turn 2 attempt should be trimmed");
    assert.equal(turn2Calls[1].previous_response_id, undefined,
      "retry must drop previous_response_id");
    assert.equal(turn2Calls[1].input.length, 3,
      "retry must restore the full input");
    assert.deepEqual(turn2Calls[1].input[2].content, [{ type: "input_text", text: "bye" }],
      "retry full input must still normalize existing text array parts");
    assert.equal([...kv.store.values()].includes("resp_def"), false,
      "stateless retry response IDs should not be cached for unsupported gateways");

    const repeatCalls = [];
    global.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      repeatCalls.push(body);
      return new Response(JSON.stringify({
        id: "resp_repeat",
        object: "response",
        model,
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "repeat" }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: turn2Messages }),
    }));

    assert.equal(repeatCalls.length, 1, "unsupported scope should not retry every request");
    assert.equal(repeatCalls[0].previous_response_id, undefined,
      "unsupported scope should skip future previous_response_id lookup");
    assert.equal(repeatCalls[0].input.length, 3,
      "unsupported scope should stay stateless");
  });

  it("two-turn flow: turn 1 caches response id, turn 2 sends previous_response_id with trimmed input", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const kv = makeInMemoryKv();
    setKvDriver(kv);

    // Turn 1: single user message. Expect: full input forwarded, store:true,
    // response id written to oairesp: KV.
    const turn1Captured = { url: null, body: null };
    global.fetch = async (url, init) => {
      turn1Captured.url = url;
      turn1Captured.body = JSON.parse(init.body);
      return new Response(JSON.stringify({
        id: "resp_abc",
        object: "response",
        model: "gpt-4o",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const turn1Messages = [
      { role: "user", content: "hi" },
    ];
    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: turn1Messages }),
    }));

    // Turn 1 forwards the full input (1 item) with store:true injected.
    assert.ok(turn1Captured.url.endsWith("/v1/responses"), "turn 1 should hit /v1/responses");
    assert.ok(Array.isArray(turn1Captured.body.input), "turn 1 should send input array");
    assert.equal(turn1Captured.body.input.length, 1, "turn 1 sends full input (1 user msg)");
    assert.equal(turn1Captured.body.input[0].content, "hi",
      "turn 1 should preserve string content for openaicompat");
    assert.equal(turn1Captured.body.store, true, "store:true must be injected on turn 1");
    assert.equal(turn1Captured.body.previous_response_id, undefined, "turn 1 has no previous_response_id");

    // The response id must be written to the oairesp: KV namespace.
    const oairespKeys = [...kv.store.keys()].filter((k) => k.startsWith("oairesp:"));
    assert.equal(oairespKeys.length, 1, "exactly one oairesp: key should be written");
    assert.equal(kv.store.get(oairespKeys[0]), "resp_abc", "cached id must be resp_abc");

    // Turn 2: same conversation + assistant reply + new user message. Expect:
    // KV hit resolves resp_abc, input trimmed to only the new user message,
    // previous_response_id set to resp_abc.
    const turn2Captured = { url: null, body: null };
    global.fetch = async (url, init) => {
      turn2Captured.url = url;
      turn2Captured.body = JSON.parse(init.body);
      return new Response(JSON.stringify({
        id: "resp_def",
        object: "response",
        model: "gpt-4o",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "bye" }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const turn2Messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ];
    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: turn2Messages }),
    }));

    // Turn 2 must chain: previous_response_id set, input trimmed.
    assert.ok(turn2Captured.url.endsWith("/v1/responses"), "turn 2 should hit /v1/responses");
    assert.equal(turn2Captured.body.previous_response_id, "resp_abc",
      "turn 2 must send previous_response_id=resp_abc (KV hit)");
    assert.ok(Array.isArray(turn2Captured.body.input), "turn 2 should send input array");
    assert.equal(turn2Captured.body.input.length, 1,
      "turn 2 input must be trimmed to only the new user message (1 item, not 3)");
    assert.equal(turn2Captured.body.input[0].content, "bye",
      "turn 2 trimmed input should preserve string content for openaicompat");
    assert.equal(turn2Captured.body.store, true, "store:true on turn 2");
  });
});
