import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/proxy.js";
import { setKvDriver } from "../lib/kv.js";

// Handler-level coverage for the azureanthropic streaming path: Anthropic SSE
// events are converted to OpenAI-format chunks, thinking deltas are suppressed
// from the client stream and cached to KV (claude_thinking:*), and
// message_stop maps to data: [DONE]. These tests invoke the shared handler
// directly with the internal rewrite URL shape; they do NOT test server.js,
// vercel.json, or the EdgeOne rewrite adapters.

const PROVIDER_URL = "http://localhost/api/proxy?provider=azureanthropic&path=chat/completions";

const ENV_KEYS = [
  "AZURE_FOUNDRY_API_KEY",
  "AZURE_ANTHROPIC_ENDPOINT",
  "AZURE_FOUNDRY_RESOURCE",
  "CURSORPROXY_API_KEY",
  "DEBUG",
];

// Minimal in-memory KV map with a Redis-like driver shape
// ({ get, set(key, value, "EX", ttl) }) so setKvDriver() picks it up.
function makeInMemoryKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async set(key, value) { store.set(key, value); },
    async del(key) { store.delete(key); },
  };
}

function sseBody(events) {
  return events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

// A canned Anthropic stream: adaptive thinking block (two deltas + signature),
// then a text block, then message_delta with stop_reason and message_stop.
const ANTHROPIC_SSE_EVENTS = [
  { event: "message_start", data: { type: "message_start", message: { id: "msg_test", role: "assistant" } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "secret plan " } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "part two" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc123" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " world" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 4 } } },
  { event: "message_stop", data: { type: "message_stop" } },
];

describe("azureanthropic streaming — handler integration", () => {
  let origFetch;
  let origEnvs = {};
  let kv;

  beforeEach(() => {
    origFetch = global.fetch;
    origEnvs = {};
    for (const k of ENV_KEYS) origEnvs[k] = process.env[k];
    process.env.AZURE_FOUNDRY_API_KEY = "az-test-key";
    process.env.AZURE_ANTHROPIC_ENDPOINT = "https://test-resource.services.ai.azure.com";
    delete process.env.CURSORPROXY_API_KEY; // avoid auth requirement in tests
    kv = makeInMemoryKv();
    setKvDriver(kv);
  });

  afterEach(() => {
    global.fetch = origFetch;
    for (const k of ENV_KEYS) {
      if (origEnvs[k] === undefined) delete process.env[k];
      else process.env[k] = origEnvs[k];
    }
    setKvDriver(null);
  });

  function mockFetchSSE(events) {
    const captured = { url: null, headers: null, body: null };
    global.fetch = async (url, init) => {
      captured.url = url;
      captured.headers = new Headers(init.headers);
      captured.body = JSON.parse(init.body);
      return new Response(sseBody(events), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    return captured;
  }

  async function streamHandler(requestBody) {
    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    }));
    assert.equal(res.status, 200);
    const text = await res.text();
    const chunks = text
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: ") && !frame.includes("[DONE]"))
      .map((frame) => JSON.parse(frame.slice(6)));
    return { res, text, chunks };
  }

  const REQUEST_BODY = {
    model: "claude-sonnet-4-6",
    stream: true,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: "hi" }],
  };

  it("converts Anthropic SSE to OpenAI chunks and terminates with [DONE]", async () => {
    const captured = mockFetchSSE(ANTHROPIC_SSE_EVENTS);
    const { res, text, chunks } = await streamHandler(REQUEST_BODY);

    assert.ok(captured.url.includes("/anthropic/v1/messages"), `unexpected upstream URL: ${captured.url}`);
    assert.equal(captured.headers.get("x-api-key"), "az-test-key");
    assert.ok((res.headers.get("content-type") || "").includes("text/event-stream"));

    const contentText = chunks
      .map((c) => c.choices?.[0]?.delta?.content || "")
      .join("");
    assert.equal(contentText, "Hello world");

    const finishChunk = chunks.find((c) => c.choices?.[0]?.finish_reason);
    assert.ok(finishChunk, "expected a finish_reason chunk from message_delta");
    assert.equal(finishChunk.choices[0].finish_reason, "stop");
    assert.equal(finishChunk.usage.prompt_tokens, 10);
    assert.equal(finishChunk.usage.completion_tokens, 4);

    assert.ok(text.includes("data: [DONE]"), "message_stop should map to data: [DONE]");
    assert.equal(text.indexOf("data: [DONE]"), text.lastIndexOf("data: [DONE]"), "no double [DONE]");
  });

  it("suppresses thinking deltas from the client stream and caches them to KV", async () => {
    mockFetchSSE(ANTHROPIC_SSE_EVENTS);
    const { text } = await streamHandler(REQUEST_BODY);

    assert.ok(!text.includes("secret plan"), "thinking text must not reach the client");
    assert.ok(!text.includes("sig-abc123"), "thinking signature must not reach the client");

    const thinkKeys = [...kv.store.keys()].filter((k) => k.startsWith("claude_thinking:"));
    assert.equal(thinkKeys.length, 1, `expected one claude_thinking KV write, keys: ${[...kv.store.keys()]}`);
    const blocks = JSON.parse(kv.store.get(thinkKeys[0]));
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "thinking");
    assert.equal(blocks[0].thinking, "secret plan part two");
    assert.equal(blocks[0].signature, "sig-abc123");
  });

  it("forwards thinking as content when thinking is disabled (no KV write)", async () => {
    mockFetchSSE(ANTHROPIC_SSE_EVENTS);
    const { text, chunks } = await streamHandler({
      ...REQUEST_BODY,
      thinking: { type: "disabled" },
    });

    // Without adaptive thinking, thinking_delta maps to plain content chunks.
    const contentText = chunks
      .map((c) => c.choices?.[0]?.delta?.content || "")
      .join("");
    assert.ok(contentText.includes("secret plan part two"), "thinking should pass through as content");
    assert.ok(contentText.includes("Hello world"));
    assert.ok(text.includes("data: [DONE]"));

    const thinkKeys = [...kv.store.keys()].filter((k) => k.startsWith("claude_thinking:"));
    assert.equal(thinkKeys.length, 0, "disabled thinking must not write claude_thinking keys");
  });
});
