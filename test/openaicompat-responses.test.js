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
  "OPENAICOMPAT_CACHE_HIT_MODE",
  "OPENAICOMPAT_CHAT_CACHE_MODE",
  "OPENAICOMPAT_REASONING_EFFORT",
  "OPENAICOMPAT_API_KEY",
  "UPSTREAM_OPENAICOMPAT",
  "AZURE_OPENAI_REASONING_EFFORT",
  "AZURE_FOUNDRY_API_KEY",
  "AZURE_FOUNDRY_RESOURCE",
  "AZURE_OPENAI_ENDPOINT",
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
  // the outbound URL, headers, and body for assertions.
  function mockFetchResponses(responsesBody) {
    let captured = { url: null, headers: null, body: null };
    global.fetch = async (url, init) => {
      captured.url = url;
      captured.headers = new Headers(init.headers);
      captured.body = JSON.parse(init.body);
      return new Response(JSON.stringify(responsesBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    return captured;
  }

  async function captureConsoleLogs(fn) {
    const origLog = console.log;
    const lines = [];
    console.log = (...args) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      const result = await fn();
      return { result, logs: lines.join("\n") };
    } finally {
      console.log = origLog;
    }
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

  it("default chat mode does not normalize provider-specific cache usage", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "chat";
    const captured = mockFetchResponses({
      id: "chat_cache_default",
      object: "chat.completion",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        cached_tokens: 70,
      },
    });

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    }));

    assert.equal(res.status, 200);
    assert.ok(captured.url.endsWith("/v1/chat/completions"), `expected chat/completions, got: ${captured.url}`);
    const body = await res.json();
    assert.equal(body.usage.cached_tokens, 70);
    assert.equal(body.usage.prompt_tokens_details, undefined);
  });

  it("chat cache facade normalizes cache usage and ignores sub2api mode in chat wire mode", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "chat";
    process.env.OPENAICOMPAT_CHAT_CACHE_MODE = "facade";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "sub2api";
    const captured = mockFetchResponses({
      id: "chat_cache_facade",
      object: "chat.completion",
      model: "gpt-5.5",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 6,
        total_tokens: 126,
        prompt_cache_hit_tokens: 90,
      },
    });

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    }));

    assert.equal(res.status, 200);
    assert.ok(captured.url.endsWith("/v1/chat/completions"), `expected chat/completions, got: ${captured.url}`);
    assert.equal(captured.body.prompt_cache_key, undefined, "sub2api prompt_cache_key injection must not run in chat mode");
    const body = await res.json();
    assert.equal(body.usage.prompt_tokens_details.cached_tokens, 90);
  });

  it("chat cache facade forces stream usage and normalizes usage chunks", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "chat";
    process.env.OPENAICOMPAT_CHAT_CACHE_MODE = "facade";
    let captured = { url: null, body: null };
    const stream = [
      "data: {\"id\":\"chatcmpl_usage\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-4o\",\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":5,\"total_tokens\":105,\"cached_tokens\":70}}",
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    global.fetch = async (url, init) => {
      captured.url = url;
      captured.body = JSON.parse(init.body);
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }),
    }));

    assert.equal(res.status, 200);
    assert.ok(captured.url.endsWith("/v1/chat/completions"), `expected chat/completions, got: ${captured.url}`);
    assert.equal(captured.body.stream_options.include_usage, true);
    const body = await res.text();
    assert.match(body, /"prompt_tokens_details":\{"cached_tokens":70\}/);
    assert.match(body, /data: \[DONE\]/);
  });

  it("chat remote mode injects a stable prompt_cache_key and leaves state mapping to upstream", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "chat";
    process.env.OPENAICOMPAT_CHAT_CACHE_MODE = "remote";
    const kv = makeInMemoryKv();
    setKvDriver(kv);
    const captured = mockFetchResponses({
      id: "chat_remote",
      object: "chat.completion",
      model: "gpt-5.5",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 6,
        total_tokens: 126,
        prompt_cache_hit_tokens: 90,
      },
    });

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", session_id: "session-1" },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      }),
    }));

    assert.equal(res.status, 200);
    assert.ok(captured.url.endsWith("/v1/chat/completions"), `expected chat/completions, got: ${captured.url}`);
    assert.ok(captured.body.messages, "remote mode should keep Chat messages");
    assert.equal(captured.body.input, undefined, "remote mode must not convert to Responses input");
    assert.equal(captured.body.previous_response_id, undefined, "remote mode must not use proxy-owned response IDs");
    assert.match(captured.body.prompt_cache_key, /^remote_session_id_[0-9a-f]{32}$/);
    assert.equal(captured.headers.get("Session_id"), "session-1",
      "remote mode should forward client session_id as upstream Session_id");
    assert.equal([...kv.store.keys()].filter((k) => k.startsWith("oairesp:")).length, 0,
      "remote mode must not write oairesp state");

    const body = await res.json();
    assert.equal(body.usage.prompt_tokens_details.cached_tokens, 90,
      "remote mode should normalize cache usage like facade mode");
  });

  it("chat remote mode preserves explicit prompt_cache_key", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "chat";
    process.env.OPENAICOMPAT_CHAT_CACHE_MODE = "remote";
    const captured = mockFetchResponses({
      id: "chat_remote_client_key",
      object: "chat.completion",
      model: "gpt-5.5",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", session_id: "session-ignored" },
      body: JSON.stringify({
        model: "gpt-5.5",
        prompt_cache_key: "client-key",
        messages: [{ role: "user", content: "hi" }],
      }),
    }));

    assert.equal(captured.body.prompt_cache_key, "client-key");
    assert.equal(captured.headers.get("Session_id"), "session-ignored",
      "remote mode should pair explicit prompt_cache_key with the client session header");
  });

  it("chat remote mode derives upstream Session_id when no client session header exists", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "chat";
    process.env.OPENAICOMPAT_CHAT_CACHE_MODE = "remote";
    const captured = mockFetchResponses({
      id: "chat_remote_derived_session",
      object: "chat.completion",
      model: "gpt-5.5",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      }),
    }));

    assert.match(captured.body.prompt_cache_key, /^remote_cs_[0-9a-f]{32}$/);
    assert.equal(captured.headers.get("Session_id"), captured.body.prompt_cache_key,
      "remote mode should reuse the derived prompt_cache_key as upstream Session_id");
  });

  it("chat remote mode forces stream usage and normalizes usage chunks", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "chat";
    process.env.OPENAICOMPAT_CHAT_CACHE_MODE = "remote";
    let captured = { url: null, body: null };
    const stream = [
      "data: {\"id\":\"chatcmpl_remote_usage\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5.5\",\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":5,\"total_tokens\":105,\"cached_tokens\":70}}",
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    global.fetch = async (url, init) => {
      captured.url = url;
      captured.body = JSON.parse(init.body);
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", conversation_id: "conv-1" },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }], stream: true }),
    }));

    assert.equal(res.status, 200);
    assert.ok(captured.url.endsWith("/v1/chat/completions"), `expected chat/completions, got: ${captured.url}`);
    assert.match(captured.body.prompt_cache_key, /^remote_conversation_id_[0-9a-f]{32}$/);
    assert.equal(captured.body.stream_options.include_usage, true);
    const body = await res.text();
    assert.match(body, /"prompt_tokens_details":\{"cached_tokens":70\}/);
    assert.match(body, /data: \[DONE\]/);
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

  it("responses mode ignores chat cache facade env", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CHAT_CACHE_MODE = "facade";
    const captured = mockFetchResponses({
      id: "resp_chat_facade_ignored",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }),
    }));

    assert.equal(res.status, 200);
    assert.ok(captured.url.endsWith("/v1/responses"), `expected responses, got: ${captured.url}`);
    assert.equal(captured.body.stream_options, undefined, "chat facade must not force stream_options in Responses mode");
  });

  it("responses mode ignores chat cache remote env", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CHAT_CACHE_MODE = "remote";
    const captured = mockFetchResponses({
      id: "resp_chat_remote_ignored",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", session_id: "session-ignored" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    }));

    assert.equal(res.status, 200);
    assert.ok(captured.url.endsWith("/v1/responses"), `expected responses, got: ${captured.url}`);
    assert.equal(captured.body.prompt_cache_key, undefined, "chat remote key injection must not run in Responses mode");
    assert.equal(captured.headers.get("Session_id"), "session-ignored",
      "Responses mode should pass client session headers through unchanged");
  });

  it("chat facade mode does not add an upstream Session_id", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "chat";
    process.env.OPENAICOMPAT_CHAT_CACHE_MODE = "facade";
    const captured = mockFetchResponses({
      id: "chat_facade_no_session",
      object: "chat.completion",
      model: "gpt-5.5",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    }));

    assert.equal(captured.body.prompt_cache_key, undefined);
    assert.equal(captured.headers.get("Session_id"), null,
      "facade mode should normalize usage only, without adding remote cache headers");
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

  it("responses mode injects OPENAICOMPAT_REASONING_EFFORT as nested reasoning effort", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_REASONING_EFFORT = "max";
    process.env.AZURE_OPENAI_REASONING_EFFORT = "minimal";
    const captured = mockFetchResponses({
      id: "resp_abc", object: "response", model: "gpt-5.6-sol", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    const { logs } = await captureConsoleLogs(async () => {
      await handler(new Request(PROVIDER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          messages: [{ role: "user", content: "hello" }],
        }),
      }));
    });

    assert.deepEqual(captured.body.reasoning, { effort: "max" });
    assert.equal(captured.body.reasoning_effort, undefined);
    assert.match(logs, /REASONING_EFFORT effort: max provider: openaicompat source: openaicompat_env/);
  });

  it("responses mode falls back from env max to xhigh for GPT-5.5", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_REASONING_EFFORT = "max";
    const captured = mockFetchResponses({
      id: "resp_gpt55", object: "response", model: "gpt-5.5", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    const { logs } = await captureConsoleLogs(async () => {
      await handler(new Request(PROVIDER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "hello" }],
        }),
      }));
    });

    assert.deepEqual(captured.body.reasoning, { effort: "xhigh" });
    assert.equal(captured.body.reasoning_effort, undefined);
    assert.match(logs, /REASONING_EFFORT effort: xhigh provider: openaicompat source: openaicompat_env/);
  });

  it("responses mode OPENAICOMPAT_REASONING_EFFORT wins over flat and nested client effort", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_REASONING_EFFORT = "high";
    const calls = [];
    global.fetch = async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        id: `resp_${calls.length}`,
        object: "response",
        model: "gpt-5.5",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "flat" }],
        reasoning_effort: "low",
      }),
    }));
    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "nested" }],
        reasoning: { effort: "minimal" },
      }),
    }));

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].reasoning, { effort: "high" });
    assert.equal(calls[0].reasoning_effort, undefined);
    assert.deepEqual(calls[1].reasoning, { effort: "high" });
  });

  it("responses mode ignores invalid OPENAICOMPAT_REASONING_EFFORT once and preserves client effort", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_REASONING_EFFORT = "turbo";
    const calls = [];
    global.fetch = async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        id: `resp_${calls.length}`,
        object: "response",
        model: "gpt-5.5",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const { logs } = await captureConsoleLogs(async () => {
      await handler(new Request(PROVIDER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "first" }],
          reasoning_effort: "high",
        }),
      }));
      await handler(new Request(PROVIDER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "second" }],
          reasoning_effort: "low",
        }),
      }));
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].reasoning, { effort: "high" });
    assert.deepEqual(calls[1].reasoning, { effort: "low" });
    assert.equal((logs.match(/OPENAICOMPAT_REASONING_EFFORT_INVALID/g) || []).length, 1);
    assert.match(logs, /OPENAICOMPAT_REASONING_EFFORT_INVALID .*raw: turbo .*fallback: client/);
    assert.match(logs, /OPENAICOMPAT_REASONING_EFFORT_INVALID .*valid: none\|minimal\|low\|medium\|high\|xhigh\|max/);
  });

  it("chat mode injects OPENAICOMPAT_REASONING_EFFORT as flat reasoning_effort", async () => {
    delete process.env.OPENAICOMPAT_WIRE_API;
    process.env.OPENAICOMPAT_REASONING_EFFORT = "xhigh";
    const captured = mockFetchResponses({
      id: "chat_abc",
      object: "chat.completion",
      model: "gpt-5.5",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    });

    const { logs } = await captureConsoleLogs(async () => {
      await handler(new Request(PROVIDER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "hello" }],
        }),
      }));
    });

    assert.ok(captured.url.endsWith("/v1/chat/completions"), `expected chat/completions, got: ${captured.url}`);
    assert.equal(captured.body.reasoning, undefined);
    assert.equal(captured.body.reasoning_effort, "xhigh");
    assert.ok(captured.body.messages, "chat mode should keep messages array");
    assert.match(logs, /OAI_CHAT_REASONING_EFFORT provider: openaicompat effort: xhigh source: openaicompat_env/);
  });

  it("chat mode falls back from env max to xhigh for GPT-5.5", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "chat";
    process.env.OPENAICOMPAT_REASONING_EFFORT = "max";
    const captured = mockFetchResponses({
      id: "chat_gpt55_max_fallback",
      object: "chat.completion",
      model: "gpt-5.5",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    });

    const { logs } = await captureConsoleLogs(async () => {
      await handler(new Request(PROVIDER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "hello" }],
        }),
      }));
    });

    assert.ok(captured.url.endsWith("/v1/chat/completions"), `expected chat/completions, got: ${captured.url}`);
    assert.equal(captured.body.reasoning, undefined);
    assert.equal(captured.body.reasoning_effort, "xhigh");
    assert.match(logs, /OAI_CHAT_REASONING_EFFORT provider: openaicompat effort: xhigh source: openaicompat_env/);
  });

  it("chat mode OPENAICOMPAT_REASONING_EFFORT wins over client reasoning_effort", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "chat";
    process.env.OPENAICOMPAT_REASONING_EFFORT = "high";
    const captured = mockFetchResponses({
      id: "chat_effort_override",
      object: "chat.completion",
      model: "gpt-5.5",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        reasoning_effort: "low",
        messages: [{ role: "user", content: "hello" }],
      }),
    }));

    assert.equal(captured.body.reasoning_effort, "high");
  });

  it("chat mode invalid OPENAICOMPAT_REASONING_EFFORT preserves client effort", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "chat";
    process.env.OPENAICOMPAT_REASONING_EFFORT = "turbo";
    const calls = [];
    global.fetch = async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        id: `chat_effort_invalid_${calls.length}`,
        object: "chat.completion",
        model: "gpt-5.5",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const { logs } = await captureConsoleLogs(async () => {
      for (const effort of ["high", "low"]) {
        await handler(new Request(PROVIDER_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-5.5",
            reasoning_effort: effort,
            messages: [{ role: "user", content: "hello" }],
          }),
        }));
      }
    });

    assert.equal(calls[0].reasoning_effort, "high");
    assert.equal(calls[1].reasoning_effort, "low");
    assert.equal((logs.match(/OPENAICOMPAT_REASONING_EFFORT_INVALID/g) || []).length, 1);
    assert.match(logs, /OPENAICOMPAT_REASONING_EFFORT_INVALID .*raw: turbo .*fallback: client/);
    assert.match(logs, /OPENAICOMPAT_REASONING_EFFORT_INVALID .*valid: none\|minimal\|low\|medium\|high\|xhigh\|max/);
  });

  it("chat mode drops apply_patch in all known shapes", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "chat";
    const captured = mockFetchResponses({
      id: "chat_apply_patch",
      object: "chat.completion",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "edit" }],
        tools: [
          { type: "apply_patch" },
          { type: "custom", name: "apply_patch", description: "Apply a patch to a file.", format: { type: "text" } },
          { type: "function", function: { name: "apply_patch", description: "Apply patch", parameters: { type: "object" } } },
          { type: "function", function: { name: "edit_file", description: "Edit a file", parameters: { type: "object" } } },
        ],
      }),
    }));

    assert.equal(captured.body.tools.length, 1);
    assert.equal(captured.body.tools[0].type, "function");
    assert.equal(captured.body.tools[0].function.name, "edit_file");
  });

  it("chat facade and remote modes inject flat OPENAICOMPAT_REASONING_EFFORT", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "chat";
    process.env.OPENAICOMPAT_REASONING_EFFORT = "xhigh";
    const calls = [];
    global.fetch = async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        id: `chat_effort_mode_${calls.length}`,
        object: "chat.completion",
        model: "gpt-5.5",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    process.env.OPENAICOMPAT_CHAT_CACHE_MODE = "facade";
    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "facade" }] }),
    }));

    process.env.OPENAICOMPAT_CHAT_CACHE_MODE = "remote";
    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", session_id: "session-1" },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "remote" }] }),
    }));

    assert.equal(calls[0].reasoning_effort, "xhigh");
    assert.equal(calls[1].reasoning_effort, "xhigh");
    assert.match(calls[1].prompt_cache_key, /^remote_session_id_[0-9a-f]{32}$/);
  });

  it("openaicompat Responses ignores Azure reasoning effort env", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.AZURE_OPENAI_REASONING_EFFORT = "xhigh";
    const captured = mockFetchResponses({
      id: "resp_abc", object: "response", model: "gpt-5.5", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hello" }],
      }),
    }));

    assert.equal(captured.body.reasoning, undefined,
      "AZURE_OPENAI_REASONING_EFFORT must not leak into openaicompat");
  });

  it("Azure OpenAI ignores OPENAICOMPAT_REASONING_EFFORT", async () => {
    process.env.OPENAICOMPAT_REASONING_EFFORT = "xhigh";
    process.env.AZURE_FOUNDRY_API_KEY = "azure-test-key";
    process.env.AZURE_OPENAI_ENDPOINT = "https://azure.example.com";
    let capturedBody = null;
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        id: "resp_azure",
        object: "response",
        model: "gpt-5.5",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await handler(new Request("http://localhost/api/proxy?provider=azureopenai&path=chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hello" }],
      }),
    }));

    assert.equal(capturedBody.reasoning, undefined,
      "OPENAICOMPAT_REASONING_EFFORT must not leak into Azure OpenAI");
  });

  it("Azure OpenAI does not accept max from AZURE_OPENAI_REASONING_EFFORT", async () => {
    process.env.AZURE_OPENAI_REASONING_EFFORT = "max";
    process.env.AZURE_FOUNDRY_API_KEY = "azure-test-key";
    process.env.AZURE_OPENAI_ENDPOINT = "https://azure.example.com";
    let capturedBody = null;
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        id: "resp_azure_max",
        object: "response",
        model: "gpt-5.5",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await handler(new Request("http://localhost/api/proxy?provider=azureopenai&path=chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        reasoning_effort: "high",
        messages: [{ role: "user", content: "hello" }],
      }),
    }));

    assert.deepEqual(capturedBody.reasoning, { effort: "high" },
      "invalid Azure max env must preserve the client effort");
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

  it("openaicompat Responses normalizer converts Chat image_url parts to input_image", () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const parsedBody = {
      input: [{
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,abc123" },
            detail: "high",
          },
        ],
      }],
    };

    const result = normalizeOpenAICompatResponsesInputContent("openaicompat", parsedBody);

    assert.equal(result.changed, true);
    assert.deepEqual(parsedBody.input[0].content, [
      { type: "input_text", text: "describe this" },
      { type: "input_image", image_url: "data:image/png;base64,abc123", detail: "high" },
    ]);
  });

  it("openaicompat Responses normalizer strips provider metadata from text and image parts", () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const parsedBody = {
      input: [{
        role: "user",
        content: [
          {
            type: "text",
            text: "describe this",
            providerOptions: { cursor: { source: "client" } },
          },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,abc123" },
            detail: "high",
            provider_options: { cursor: { image: true } },
            providerMetadata: { foo: "bar" },
            experimental_providerMetadata: { baz: true },
          },
        ],
      }],
    };

    const result = normalizeOpenAICompatResponsesInputContent("openaicompat", parsedBody);

    assert.equal(result.changed, true);
    assert.deepEqual(parsedBody.input[0].content, [
      { type: "input_text", text: "describe this" },
      { type: "input_image", image_url: "data:image/png;base64,abc123", detail: "high" },
    ]);
  });

  it("openaicompat Responses normalizer preserves string image_url and existing input_image parts", () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const parsedBody = {
      input: [{
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: "https://example.com/cat.png",
            detail: "low",
          },
          {
            type: "input_image",
            image_url: "data:image/jpeg;base64,already",
            detail: "auto",
          },
        ],
      }],
    };

    const result = normalizeOpenAICompatResponsesInputContent("openaicompat", parsedBody);

    assert.equal(result.changed, true);
    assert.deepEqual(parsedBody.input[0].content, [
      { type: "input_image", image_url: "https://example.com/cat.png", detail: "low" },
      { type: "input_image", image_url: "data:image/jpeg;base64,already", detail: "auto" },
    ]);
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

    let bodyText = "";
    const { result: res, logs } = await captureConsoleLogs(async () => {
      const response = await handler(new Request(PROVIDER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "start subagent" }], stream: true }),
      }));
      bodyText = await response.text();
      return response;
    });

    assert.equal(res.status, 200);
    const chunks = bodyText
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
    assert.match(logs, /OAI_TOOL_CALL_START .*name: start_subagent .*toolIndex: 0 .*responsesIndex: 2/);
    assert.match(logs, /OAI_TOOL_CALL_DONE .*name: start_subagent .*toolIndex: 0 .*argChars: 18 .*argKeys: task/);
    assert.doesNotMatch(logs, /inspect/, "tool-call diagnostics must not log argument values");
  });

  it("preserves interleaved Shell and Task calls across GPT-5.6 and GPT-5.5 streams", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const shellPayload = {
      command: "pwd",
      description: "Inspect workspace",
      working_directory: "/tmp",
      block_until_ms: 30000,
    };
    const taskPayload = {
      description: "Inspect workspace",
      prompt: "Inspect the workspace without edits.",
      readonly: true,
      run_in_background: false,
      subagent_type: "explore",
    };
    const shellArgs = JSON.stringify(shellPayload);
    const taskArgs = JSON.stringify(taskPayload);
    const shellSplitIndex = Math.floor(shellArgs.length / 2);
    const taskSplitIndex = Math.floor(taskArgs.length / 2);
    const stream = [
      "event: response.created",
      `data: ${JSON.stringify({
        type: "response.created",
        response: { id: "resp_interleaved_tools", status: "in_progress" },
      })}`,
      "",
      "event: response.output_item.added",
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 2,
        item: {
          id: "fc_shell",
          type: "function_call",
          call_id: "call_shell",
          name: "Shell",
        },
      })}`,
      "",
      "event: response.output_item.added",
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 5,
        item: {
          id: "fc_task",
          type: "function_call",
          call_id: "call_task",
          name: "Task",
        },
      })}`,
      "",
      "event: response.function_call_arguments.delta",
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        output_index: 2,
        item_id: "fc_shell",
        delta: shellArgs.slice(0, shellSplitIndex),
      })}`,
      "",
      "event: response.function_call_arguments.delta",
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        output_index: 5,
        item_id: "fc_task",
        delta: taskArgs.slice(0, taskSplitIndex),
      })}`,
      "",
      "event: response.function_call_arguments.delta",
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        output_index: 2,
        item_id: "fc_shell",
        delta: shellArgs.slice(shellSplitIndex),
      })}`,
      "",
      "event: response.function_call_arguments.delta",
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        output_index: 5,
        item_id: "fc_task",
        delta: taskArgs.slice(taskSplitIndex),
      })}`,
      "",
      "event: response.function_call_arguments.done",
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.done",
        output_index: 2,
        item_id: "fc_shell",
        arguments: shellArgs,
      })}`,
      "",
      "event: response.function_call_arguments.done",
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.done",
        output_index: 5,
        item_id: "fc_task",
        arguments: taskArgs,
      })}`,
      "",
      "event: response.completed",
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_interleaved_tools",
          status: "completed",
          error: null,
        },
      })}`,
      "",
    ].join("\n");

    async function replayScenario({
      requestModel,
      expectedUpstreamModel,
      expectedFinalShellToolCall,
      expectedToolIndexSequence,
      expectSingleShellIdentity,
    }) {
      let outboundBody = null;
      global.fetch = async (_url, init) => {
        outboundBody = JSON.parse(init.body);
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };

      const response = await handler(new Request(PROVIDER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: requestModel,
          messages: [{ role: "user", content: "Inspect the workspace" }],
          stream: true,
        }),
      }));
      const bodyText = await response.text();

      assert.equal(response.status, 200, `${requestModel} should return HTTP 200`);
      assert.equal(outboundBody.model, expectedUpstreamModel,
        `${requestModel} should resolve to the expected upstream model`);

      const orderedDataLines = bodyText
        .split("\n")
        .filter((line) => line.startsWith("data: "));
      const doneDataLineIndex = orderedDataLines.indexOf("data: [DONE]");
      const parsedDataLines = orderedDataLines
        .filter((line) => line !== "data: [DONE]")
        .map((line) => JSON.parse(line.slice(6)));
      const emittedToolCalls = parsedDataLines.flatMap((chunk) =>
        (chunk.choices?.[0]?.delta?.tool_calls || []).map((toolCall) => ({ toolCall })));
      assert.deepEqual(
        emittedToolCalls.map(({ toolCall }) => toolCall.index),
        expectedToolIndexSequence,
        `${requestModel} should preserve the expected downstream tool chunk order`,
      );

      const identityBearingStartCalls = emittedToolCalls
        .map(({ toolCall }) => toolCall)
        .filter((toolCall) => toolCall.function?.arguments === "");
      assert.deepEqual(identityBearingStartCalls, [
        {
          index: 0,
          id: "call_shell",
          type: "function",
          function: { name: "Shell", arguments: "" },
        },
        {
          index: 1,
          id: "call_task",
          type: "function",
          function: { name: "Task", arguments: "" },
        },
      ], `${requestModel} should emit each identity-bearing start chunk exactly once`);

      const argumentsByToolIndex = new Map();
      for (const { toolCall } of emittedToolCalls) {
        const argumentDelta = toolCall.function?.arguments;
        if (typeof argumentDelta !== "string") continue;
        const existingArguments = argumentsByToolIndex.get(toolCall.index) || "";
        argumentsByToolIndex.set(toolCall.index, existingArguments + argumentDelta);
      }
      assert.deepEqual(JSON.parse(argumentsByToolIndex.get(0)), shellPayload,
        `${requestModel} should reconstruct Shell arguments by dense index 0`);
      assert.deepEqual(JSON.parse(argumentsByToolIndex.get(1)), taskPayload,
        `${requestModel} should reconstruct Task arguments by dense index 1`);

      const finishReasonDataLineIndex = orderedDataLines.findIndex((line) => {
        if (line === "data: [DONE]") return false;
        const chunk = JSON.parse(line.slice(6));
        return chunk.choices?.[0]?.finish_reason === "tool_calls";
      });
      assert.ok(finishReasonDataLineIndex >= 0,
        `${requestModel} should emit finish_reason=tool_calls`);
      assert.ok(doneDataLineIndex > finishReasonDataLineIndex,
        `${requestModel} should emit finish_reason=tool_calls before [DONE]`);

      const finalShellToolCall = emittedToolCalls
        .map(({ toolCall }) => toolCall)
        .filter((toolCall) =>
          toolCall.index === 0 && Boolean(toolCall.function?.arguments))
        .at(-1);
      assert.deepEqual(finalShellToolCall, expectedFinalShellToolCall,
        `${requestModel} should preserve the expected final Shell chunk shape`);

      if (expectSingleShellIdentity) {
        const identityBearingShellCalls = emittedToolCalls
          .map(({ toolCall }) => toolCall)
          .filter((toolCall) => toolCall.index === 0)
          .filter((toolCall) =>
            Object.hasOwn(toolCall, "id")
            || Object.hasOwn(toolCall, "type")
            || Object.hasOwn(toolCall.function || {}, "name"));
        assert.equal(identityBearingShellCalls.length, 1,
          "GPT-5.6 should emit only one identity-bearing Shell tool call");
      }
    }

    await replayScenario({
      requestModel: "cursorproxy/compatible-gpt-5.6",
      expectedUpstreamModel: "gpt-5.6-sol",
      expectedFinalShellToolCall: {
        index: 0,
        function: { arguments: shellArgs },
      },
      expectedToolIndexSequence: [0, 0, 1, 1],
      expectSingleShellIdentity: true,
    });
    await replayScenario({
      requestModel: "gpt-5.5",
      expectedUpstreamModel: "gpt-5.5",
      expectedFinalShellToolCall: {
        index: 0,
        id: "call_shell",
        type: "function",
        function: { name: "Shell", arguments: shellArgs },
      },
      expectedToolIndexSequence: [0, 1, 1, 1, 0],
      expectSingleShellIdentity: false,
    });
  });

  it("releases deferred GPT-5.6 tool chunks when Shell never completes", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const taskArgs = JSON.stringify({
      description: "Inspect workspace",
      prompt: "Inspect without edits.",
      readonly: true,
      run_in_background: false,
      subagent_type: "explore",
    });
    const stream = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_incomplete_shell\",\"status\":\"in_progress\"}}",
      "",
      "event: response.output_item.added",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":2,\"item\":{\"id\":\"fc_shell_incomplete\",\"type\":\"function_call\",\"call_id\":\"call_shell_incomplete\",\"name\":\"Shell\"}}",
      "",
      "event: response.output_item.added",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":5,\"item\":{\"id\":\"fc_task_after_shell\",\"type\":\"function_call\",\"call_id\":\"call_task_after_shell\",\"name\":\"Task\"}}",
      "",
      "event: response.function_call_arguments.delta",
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        output_index: 5,
        item_id: "fc_task_after_shell",
        delta: taskArgs,
      })}`,
      "",
      "event: response.function_call_arguments.done",
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.done",
        output_index: 5,
        item_id: "fc_task_after_shell",
        arguments: taskArgs,
      })}`,
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_incomplete_shell\",\"status\":\"completed\",\"error\":null}}",
      "",
    ].join("\n");
    global.fetch = async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const response = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "cursorproxy/compatible-gpt-5.6",
        messages: [{ role: "user", content: "Inspect the workspace" }],
        stream: true,
      }),
    }));
    const bodyText = await response.text();
    const dataLines = bodyText
      .split("\n")
      .filter((line) => line.startsWith("data: "));
    const chunks = dataLines
      .filter((line) => line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const emittedToolCalls = chunks.flatMap((chunk) =>
      chunk.choices?.[0]?.delta?.tool_calls || []);

    assert.equal(response.status, 200);
    assert.deepEqual(emittedToolCalls.map((toolCall) => toolCall.index), [0, 1, 1]);
    const taskArgumentText = emittedToolCalls
      .filter((toolCall) => toolCall.index === 1)
      .map((toolCall) => toolCall.function?.arguments || "")
      .join("");
    assert.deepEqual(JSON.parse(taskArgumentText), JSON.parse(taskArgs));
    const finishIndex = chunks.findIndex((chunk) =>
      chunk.choices?.[0]?.finish_reason === "tool_calls");
    const taskDoneIndex = chunks.findIndex((chunk) =>
      chunk.choices?.[0]?.delta?.tool_calls?.[0]?.index === 1
      && Boolean(chunk.choices[0].delta.tool_calls[0].function?.arguments));
    assert.ok(taskDoneIndex >= 0 && taskDoneIndex < finishIndex,
      "deferred Task arguments must be released before finish_reason=tool_calls");
  });

  it("sanitizes invalid optional GPT-5.6 Task arguments for local execution", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const taskArgs = JSON.stringify({
      description: "Verify standalone subagent launch",
      prompt: "Inspect the workspace without editing.",
      model: "",
      resume: "",
      readonly: true,
      subagent_type: "explore",
      file_attachments: [],
      environment: "local",
      cloud_base_branch: "",
      interrupt: false,
      run_in_background: false,
    });
    const midpoint = Math.floor(taskArgs.length / 2);
    const stream = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_task_local\",\"status\":\"in_progress\"}}",
      "",
      "event: response.output_item.added",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":2,\"item\":{\"id\":\"fc_task_local\",\"type\":\"function_call\",\"call_id\":\"call_task_local\",\"name\":\"Task\"}}",
      "",
      "event: response.function_call_arguments.delta",
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        output_index: 2,
        item_id: "fc_task_local",
        delta: taskArgs.slice(0, midpoint),
      })}`,
      "",
      "event: response.function_call_arguments.delta",
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        output_index: 2,
        item_id: "fc_task_local",
        delta: taskArgs.slice(midpoint),
      })}`,
      "",
      "event: response.function_call_arguments.done",
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.done",
        output_index: 2,
        item_id: "fc_task_local",
        arguments: taskArgs,
      })}`,
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_task_local\",\"status\":\"completed\",\"error\":null}}",
      "",
    ].join("\n");
    global.fetch = async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    let bodyText = "";
    const { result: response, logs } = await captureConsoleLogs(async () => {
      const handlerResponse = await handler(new Request(PROVIDER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "cursorproxy/compatible-gpt-5.6",
          messages: [{ role: "user", content: "Start a local Task" }],
          stream: true,
        }),
      }));
      bodyText = await handlerResponse.text();
      return handlerResponse;
    });

    assert.equal(response.status, 200);
    assert.doesNotMatch(bodyText, /cloud_base_branch/);
    assert.match(
      logs,
      /OAI_TASK_ARGS_SANITIZED .*name: Task .*removed: cloud_base_branch,model,resume/,
    );
    const chunks = bodyText
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const taskToolCalls = chunks.flatMap((chunk) =>
      chunk.choices?.[0]?.delta?.tool_calls || []);
    assert.deepEqual(taskToolCalls.map((toolCall) => toolCall.index), [0, 0]);
    assert.deepEqual(taskToolCalls[0], {
      index: 0,
      id: "call_task_local",
      type: "function",
      function: { name: "Task", arguments: "" },
    });
    assert.deepEqual(taskToolCalls[1], {
      index: 0,
      function: {
        arguments: JSON.stringify({
          description: "Verify standalone subagent launch",
          prompt: "Inspect the workspace without editing.",
          readonly: true,
          subagent_type: "explore",
          file_attachments: [],
          environment: "local",
          interrupt: false,
          run_in_background: false,
        }),
      },
    });
  });

  it("preserves valid GPT-5.6 cloud Task arguments", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const taskArgs = JSON.stringify({
      description: "Inspect cloud branch",
      prompt: "Inspect without editing.",
      model: "composer-2.5-fast",
      resume: "agent_previous",
      readonly: true,
      subagent_type: "explore",
      file_attachments: [],
      environment: "cloud",
      cloud_base_branch: "main",
      interrupt: false,
      run_in_background: true,
    });
    const stream = [
      "event: response.output_item.added",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":2,\"item\":{\"id\":\"fc_task_cloud\",\"type\":\"function_call\",\"call_id\":\"call_task_cloud\",\"name\":\"Task\"}}",
      "",
      "event: response.function_call_arguments.delta",
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        output_index: 2,
        item_id: "fc_task_cloud",
        delta: taskArgs,
      })}`,
      "",
      "event: response.function_call_arguments.done",
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.done",
        output_index: 2,
        item_id: "fc_task_cloud",
        arguments: taskArgs,
      })}`,
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_task_cloud\",\"status\":\"completed\",\"error\":null}}",
      "",
    ].join("\n");
    global.fetch = async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const response = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "cursorproxy/compatible-gpt-5.6",
        messages: [{ role: "user", content: "Start a cloud Task" }],
        stream: true,
      }),
    }));
    const bodyText = await response.text();
    const taskArgumentText = bodyText
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)))
      .flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || [])
      .map((toolCall) => toolCall.function?.arguments || "")
      .join("");

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(taskArgumentText), JSON.parse(taskArgs));
  });

  it("preserves GPT-5.5 Task arguments unchanged", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const taskArgs = JSON.stringify({
      description: "Verify standalone subagent launch",
      prompt: "Inspect the workspace without editing.",
      model: "",
      resume: "",
      readonly: true,
      subagent_type: "explore",
      file_attachments: [],
      environment: "local",
      cloud_base_branch: "",
      interrupt: false,
      run_in_background: false,
    });
    const stream = [
      "event: response.output_item.added",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":2,\"item\":{\"id\":\"fc_task_gpt55\",\"type\":\"function_call\",\"call_id\":\"call_task_gpt55\",\"name\":\"Task\"}}",
      "",
      "event: response.function_call_arguments.delta",
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        output_index: 2,
        item_id: "fc_task_gpt55",
        delta: taskArgs,
      })}`,
      "",
      "event: response.function_call_arguments.done",
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.done",
        output_index: 2,
        item_id: "fc_task_gpt55",
        arguments: taskArgs,
      })}`,
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_task_gpt55\",\"status\":\"completed\",\"error\":null}}",
      "",
    ].join("\n");
    global.fetch = async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    let bodyText = "";
    const { result: response, logs } = await captureConsoleLogs(async () => {
      const handlerResponse = await handler(new Request(PROVIDER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "Start a local Task" }],
          stream: true,
        }),
      }));
      bodyText = await handlerResponse.text();
      return handlerResponse;
    });
    const taskArgumentText = bodyText
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)))
      .flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || [])
      .map((toolCall) => toolCall.function?.arguments || "")
      .join("");

    assert.equal(response.status, 200);
    assert.equal(taskArgumentText, taskArgs);
    assert.doesNotMatch(logs, /OAI_TASK_ARGS_SANITIZED/);
  });

  it("sanitizes Cursor Subagent cloud-only arguments before forwarding the tool call", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const args = JSON.stringify({
      cloud_base_branch: "main",
      description: "review docs",
      environment: "prod",
      file_attachments: ["secret.txt"],
      interrupt: false,
      model: "inherit",
      prompt: "inspect docs",
      readonly: true,
      resume: false,
      run_in_background: true,
      subagent_type: "review",
    });
    const midpoint = Math.floor(args.length / 2);
    const stream = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_subagent\",\"status\":\"in_progress\",\"model\":\"gpt-4o\"}}",
      "",
      "event: response.output_item.added",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"id\":\"fc_sub\",\"type\":\"function_call\",\"call_id\":\"call_sub\",\"name\":\"Subagent\"}}",
      "",
      "event: response.function_call_arguments.delta",
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_sub", delta: args.slice(0, midpoint) })}`,
      "",
      "event: response.function_call_arguments.delta",
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_sub", delta: args.slice(midpoint) })}`,
      "",
      "event: response.function_call_arguments.done",
      `data: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_sub", arguments: args })}`,
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_subagent\",\"status\":\"completed\",\"error\":null}}",
      "",
    ].join("\n");
    global.fetch = async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    let bodyText = "";
    const { result: res, logs } = await captureConsoleLogs(async () => {
      const response = await handler(new Request(PROVIDER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "start subagent" }], stream: true }),
      }));
      bodyText = await response.text();
      return response;
    });

    assert.equal(res.status, 200);
    assert.doesNotMatch(bodyText, /cloud_base_branch/);
    assert.doesNotMatch(bodyText, /file_attachments/);
    assert.doesNotMatch(bodyText, /"environment"/);
    assert.match(logs, /OAI_SUBAGENT_ARGS_SANITIZED .*removed: cloud_base_branch,environment,file_attachments/);

    const chunks = bodyText
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const argText = chunks
      .flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || [])
      .map((toolCall) => toolCall.function?.arguments || "")
      .join("");
    const sanitized = JSON.parse(argText);
    assert.deepEqual(Object.keys(sanitized), [
      "description",
      "interrupt",
      "model",
      "prompt",
      "readonly",
      "resume",
      "run_in_background",
      "subagent_type",
    ]);
    assert.equal(sanitized.prompt, "inspect docs");
    assert.equal(sanitized.readonly, true);
    assert.ok(chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "tool_calls"),
      "sanitized Subagent call still needs finish_reason=tool_calls");
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

  it("default Responses mode repairs tool args when done carries missing streamed args", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const args = JSON.stringify({ command: "pwd", working_directory: "/tmp" });
    const stream = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_shell\",\"status\":\"in_progress\",\"model\":\"gpt-5.5\"}}",
      "",
      "event: response.output_item.added",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"id\":\"fc_shell\",\"type\":\"function_call\",\"call_id\":\"call_shell\",\"name\":\"Shell\"}}",
      "",
      "event: response.function_call_arguments.delta",
      "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"item_id\":\"fc_shell\",\"delta\":\"\"}",
      "",
      "event: response.function_call_arguments.done",
      `data: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_shell", arguments: args })}`,
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_shell\",\"status\":\"completed\",\"error\":null}}",
      "",
    ].join("\n");
    global.fetch = async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "run pwd" }], stream: true }),
    }));

    assert.equal(res.status, 200);
    const bodyText = await res.text();
    const chunks = bodyText
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const argText = chunks
      .flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || [])
      .map((toolCall) => toolCall.function?.arguments || "")
      .join("");
    assert.equal(argText, args);
  });

  it("logs sanitized Shell argument shape in debug mode without argument values", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.DEBUG = "true";
    const args = JSON.stringify({
      block_until_ms: 30000,
      command: "printf shell-secret-value",
      description: "Run hidden diagnostic",
      notify_on_output: {
        pattern: "",
        reason: "",
        debounce_ms: 0,
      },
      request_smart_mode_approval: false,
      smart_mode_block_reason: "",
      working_directory: "/tmp/secret-workspace",
    });
    const stream = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_shell_shape\",\"status\":\"in_progress\",\"model\":\"gpt-5.5\"}}",
      "",
      "event: response.output_item.added",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"id\":\"fc_shell_shape\",\"type\":\"function_call\",\"call_id\":\"call_shell_shape\",\"name\":\"Shell\"}}",
      "",
      "event: response.function_call_arguments.delta",
      "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"item_id\":\"fc_shell_shape\",\"delta\":\"\"}",
      "",
      "event: response.function_call_arguments.done",
      `data: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_shell_shape", arguments: args })}`,
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_shell_shape\",\"status\":\"completed\",\"error\":null}}",
      "",
    ].join("\n");
    global.fetch = async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    let bodyText = "";
    const { result: res, logs } = await captureConsoleLogs(async () => {
      const response = await handler(new Request(PROVIDER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "run shell diagnostic" }], stream: true }),
      }));
      bodyText = await response.text();
      return response;
    });

    assert.equal(res.status, 200);
    const chunks = bodyText
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const argText = chunks
      .flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || [])
      .map((toolCall) => toolCall.function?.arguments || "")
      .join("");
    const sanitized = JSON.parse(argText);
    assert.equal(sanitized.command, "printf shell-secret-value");
    assert.equal(sanitized.working_directory, "/tmp/secret-workspace");
    assert.equal(sanitized.notify_on_output, undefined);

    assert.match(logs, /OAI_TOOL_CALL_DONE .*name: Shell .*argKeys: block_until_ms,command,description,notify_on_output,request_smart_mode_approval,smart_mode_block_reason,working_directory/);
    assert.match(logs, /OAI_TOOL_ARG_SHAPE .*name: Shell .*shape: object .*keyCount: 7/);
    assert.match(logs, /OAI_TOOL_ARG_SHAPE .*commandLen: 25 .*descriptionLen: 21 .*workingDirectory: present/);
    assert.match(logs, /OAI_TOOL_ARG_SHAPE .*notify: present .*notifyPatternLen: 0 .*notifyReasonLen: 0 .*notifyDebounceMs: 0/);
    assert.match(logs, /OAI_SHELL_ARGS_SANITIZED .*removed: notify_on_output .*reason: empty_pattern .*argKeys: block_until_ms,command,description,request_smart_mode_approval,smart_mode_block_reason,working_directory/);
    assert.doesNotMatch(logs, /shell-secret-value/);
    assert.doesNotMatch(logs, /secret-workspace/);
    assert.doesNotMatch(logs, /Run hidden diagnostic/);
  });

  it("preserves Shell notify_on_output when pattern is non-empty", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const args = JSON.stringify({
      command: "pwd",
      working_directory: "/tmp",
      notify_on_output: {
        pattern: "READY",
        reason: "startup",
        debounce_ms: 5000,
      },
    });
    const stream = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_shell_notify\",\"status\":\"in_progress\",\"model\":\"gpt-5.5\"}}",
      "",
      "event: response.output_item.added",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"id\":\"fc_shell_notify\",\"type\":\"function_call\",\"call_id\":\"call_shell_notify\",\"name\":\"Shell\"}}",
      "",
      "event: response.function_call_arguments.delta",
      "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"item_id\":\"fc_shell_notify\",\"delta\":\"\"}",
      "",
      "event: response.function_call_arguments.done",
      `data: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_shell_notify", arguments: args })}`,
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_shell_notify\",\"status\":\"completed\",\"error\":null}}",
      "",
    ].join("\n");
    global.fetch = async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    let bodyText = "";
    const { result: res, logs } = await captureConsoleLogs(async () => {
      const response = await handler(new Request(PROVIDER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "run shell with watcher" }], stream: true }),
      }));
      bodyText = await response.text();
      return response;
    });

    assert.equal(res.status, 200);
    const chunks = bodyText
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const argText = chunks
      .flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || [])
      .map((toolCall) => toolCall.function?.arguments || "")
      .join("");
    assert.deepEqual(JSON.parse(argText), JSON.parse(args));
    assert.doesNotMatch(logs, /OAI_SHELL_ARGS_SANITIZED/);
  });

  it("halo Responses cache mode repairs tool args when done carries missing streamed args", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "halo";
    const args = JSON.stringify({ command: "pwd", working_directory: "/tmp" });
    const stream = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_shell\",\"status\":\"in_progress\",\"model\":\"gpt-5.5\"}}",
      "",
      "event: response.output_item.added",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"id\":\"fc_shell\",\"type\":\"function_call\",\"call_id\":\"call_shell\",\"name\":\"Shell\"}}",
      "",
      "event: response.function_call_arguments.delta",
      "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"item_id\":\"fc_shell\",\"delta\":\"\"}",
      "",
      "event: response.function_call_arguments.done",
      `data: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_shell", arguments: args })}`,
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_shell\",\"status\":\"completed\",\"error\":null}}",
      "",
    ].join("\n");
    global.fetch = async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "run pwd" }], stream: true }),
    }));

    assert.equal(res.status, 200);
    const bodyText = await res.text();
    const chunks = bodyText
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const argText = chunks
      .flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || [])
      .map((toolCall) => toolCall.function?.arguments || "")
      .join("");
    assert.equal(argText, args);
  });

  it("sub2api mode does not use the default done-argument repair", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "sub2api";
    const args = JSON.stringify({ server: "example", toolName: "lookup", arguments: { id: 1 } });
    const stream = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_mcp\",\"status\":\"in_progress\",\"model\":\"gpt-5.5\"}}",
      "",
      "event: response.output_item.added",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"id\":\"fc_mcp\",\"type\":\"function_call\",\"call_id\":\"call_mcp\",\"name\":\"CallMcpTool\"}}",
      "",
      "event: response.function_call_arguments.delta",
      "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"item_id\":\"fc_mcp\",\"delta\":\"\"}",
      "",
      "event: response.function_call_arguments.done",
      `data: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_mcp", arguments: args })}`,
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_mcp\",\"status\":\"completed\",\"error\":null}}",
      "",
    ].join("\n");
    global.fetch = async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "run pwd" }], stream: true }),
    }));

    assert.equal(res.status, 200);
    const bodyText = await res.text();
    const chunks = bodyText
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const argText = chunks
      .flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || [])
      .map((toolCall) => toolCall.function?.arguments || "")
      .join("");
    assert.equal(argText, "");
  });

  it("sub2api mode sanitizes Shell notify_on_output with empty pattern", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "sub2api";
    const args = JSON.stringify({
      command: "pwd",
      working_directory: "/tmp",
      notify_on_output: {
        pattern: "",
        reason: "",
        debounce_ms: 0,
      },
    });
    const stream = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_shell_sub2api\",\"status\":\"in_progress\",\"model\":\"gpt-5.5\"}}",
      "",
      "event: response.output_item.added",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"id\":\"fc_shell_sub2api\",\"type\":\"function_call\",\"call_id\":\"call_shell_sub2api\",\"name\":\"Shell\"}}",
      "",
      "event: response.function_call_arguments.delta",
      "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"item_id\":\"fc_shell_sub2api\",\"delta\":\"\"}",
      "",
      "event: response.function_call_arguments.done",
      `data: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_shell_sub2api", arguments: args })}`,
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_shell_sub2api\",\"status\":\"completed\",\"error\":null}}",
      "",
    ].join("\n");
    global.fetch = async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    let bodyText = "";
    const { result: res, logs } = await captureConsoleLogs(async () => {
      const response = await handler(new Request(PROVIDER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "run pwd" }], stream: true }),
      }));
      bodyText = await response.text();
      return response;
    });

    assert.equal(res.status, 200);
    const chunks = bodyText
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const argText = chunks
      .flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || [])
      .map((toolCall) => toolCall.function?.arguments || "")
      .join("");
    assert.deepEqual(JSON.parse(argText), {
      command: "pwd",
      working_directory: "/tmp",
    });
    assert.match(logs, /OAI_SHELL_ARGS_SANITIZED .*removed: notify_on_output .*reason: empty_pattern/);
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

  // ─── Alias path: compatible-gpt-5.6 ─────────────────────────────────────

  it("compatible-gpt-5.6 alias routes to openaicompat Responses and maps response model back", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const captured = mockFetchResponses({
      id: "resp_abc",
      object: "response",
      model: "gpt-5.6-sol",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    const res = await handler(new Request("http://localhost/api/proxy?path=chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "cursorproxy/compatible-gpt-5.6",
        messages: [{ role: "user", content: "hi" }],
      }),
    }));

    assert.equal(res.status, 200);
    assert.ok(captured.url.endsWith("/v1/responses"), `expected responses endpoint, got: ${captured.url}`);
    assert.equal(captured.body.model, "gpt-5.6-sol");
    const body = await res.json();
    // Response model should reflect the public alias, not the upstream gpt-5.6-sol
    assert.equal(body.model, "cursorproxy/compatible-gpt-5.6");
  });

  // ─── Alias path: cursor-openai-5.5 ────────────────────────────────────────

  it("cursor-openai-5.5 alias routes to openaicompat chat mode and maps response model back", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "chat";
    const captured = mockFetchResponses({
      id: "chat_cursor_openai",
      object: "chat.completion",
      model: "gpt-5.5",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    });

    const res = await handler(new Request("http://localhost/api/proxy?path=chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "cursorproxy/cursor-openai-5.5",
        messages: [{ role: "user", content: "hi" }],
      }),
    }));

    assert.equal(res.status, 200);
    assert.equal(captured.body.model, "gpt-5.5");
    const body = await res.json();
    // Response model should reflect the public alias, not the upstream gpt-5.5
    assert.equal(body.model, "cursorproxy/cursor-openai-5.5");
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

  it("sub2api mode injects a derived prompt_cache_key for GPT-5/Codex models only", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "sub2api";
    const captured = mockFetchResponses({
      id: "resp_prompt_key",
      object: "response",
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [
          { role: "system", content: "be concise" },
          { role: "user", content: "hi" },
        ],
      }),
    }));

    assert.match(captured.body.prompt_cache_key, /^compat_cc_[0-9a-f]{32}$/);

    const nonGpt = mockFetchResponses({
      id: "resp_no_prompt_key",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });
    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    }));
    assert.equal(nonGpt.body.prompt_cache_key, undefined);
  });

  it("sub2api mode preserves explicit prompt_cache_key", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "sub2api";
    const captured = mockFetchResponses({
      id: "resp_explicit_prompt_key",
      object: "response",
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        prompt_cache_key: "client-key",
        messages: [{ role: "user", content: "hi" }],
      }),
    }));

    assert.equal(captured.body.prompt_cache_key, "client-key");
  });

  it("sub2api mode normalizes Chat image_url parts to Responses input_image", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "sub2api";
    const captured = mockFetchResponses({
      id: "resp_sub2api_image",
      object: "response",
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    const { logs } = await captureConsoleLogs(async () => handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,abc123" },
              detail: "high",
              providerOptions: { cursor: { attachment: true } },
            },
          ],
        }],
      }),
    })));

    assert.deepEqual(captured.body.input[0].content, [
      { type: "input_text", text: "describe this" },
      { type: "input_image", image_url: "data:image/png;base64,abc123", detail: "high" },
    ]);
    assert.match(captured.body.prompt_cache_key, /^compat_cc_[0-9a-f]{32}$/);
    assert.match(logs, /OAI_INPUT_NORMALIZED provider: openaicompat textParts: 1 imageParts: 1 providerOptionParts: 1/);
  });

  it("halo Responses cache mode injects prompt_cache_key and forwards Session_id", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "halo";
    const captured = mockFetchResponses({
      id: "resp_halo_prompt_key",
      object: "response",
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "session_id": "halo-session-1",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [
          { role: "system", content: "be concise" },
          { role: "user", content: "hi" },
        ],
      }),
    }));

    assert.match(captured.body.prompt_cache_key, /^halo_session_id_[0-9a-f]{32}$/);
    assert.equal(captured.headers.get("Session_id"), "halo-session-1");
    assert.equal(captured.body.store, true);
    assert.equal(captured.body.previous_response_id, undefined);
  });

  it("halo Responses cache mode normalizes Chat image_url parts to Responses input_image", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "halo";
    const captured = mockFetchResponses({
      id: "resp_halo_image",
      object: "response",
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    const { logs } = await captureConsoleLogs(async () => handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "session_id": "halo-session-image",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image_url",
              image_url: "https://example.com/cat.png",
              detail: "low",
              providerOptions: { cursor: { attachment: true } },
            },
          ],
        }],
      }),
    })));

    assert.deepEqual(captured.body.input[0].content, [
      { type: "input_text", text: "describe this" },
      { type: "input_image", image_url: "https://example.com/cat.png", detail: "low" },
    ]);
    assert.match(captured.body.prompt_cache_key, /^halo_session_id_[0-9a-f]{32}$/);
    assert.equal(captured.headers.get("Session_id"), "halo-session-image");
    assert.match(logs, /OAI_INPUT_NORMALIZED provider: openaicompat textParts: 1 imageParts: 1 providerOptionParts: 1/);
  });

  it("halo Responses cache mode preserves explicit prompt_cache_key and derives Session_id from it", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "halo";
    const captured = mockFetchResponses({
      id: "resp_halo_explicit_key",
      object: "response",
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        prompt_cache_key: "client-halo-key",
        messages: [{ role: "user", content: "hi" }],
      }),
    }));

    assert.equal(captured.body.prompt_cache_key, "client-halo-key");
    assert.equal(captured.headers.get("Session_id"), "client-halo-key");
    assert.equal(captured.body.store, true);
  });

  it("rejects remote as an invalid Responses cache-hit mode", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "remote";
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const { result: res, logs } = await captureConsoleLogs(async () => handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "session_id": "halo-session-1",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      }),
    })));

    assert.equal(fetchCalled, false);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "openaicompat_cache_hit_mode_invalid");
    assert.match(body.error.message, /Valid Responses values: default\|sub2api\|halo/);
    assert.match(logs, /OPENAICOMPAT_CACHE_HIT_MODE_INVALID raw: remote valid: default\|sub2api\|halo/);
  });

  it("sub2api mode refreshes a stale previous_response_id after previous_response_not_found", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "sub2api";
    const kv = makeInMemoryKv();
    setKvDriver(kv);

    global.fetch = async () => new Response(JSON.stringify({
      id: "resp_abc",
      object: "response",
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
    }), { status: 200, headers: { "content-type": "application/json" } });

    const turn1Messages = [{ role: "user", content: "hi" }];
    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", messages: turn1Messages }),
    }));
    assert.ok([...kv.store.values()].includes("resp_abc"), "turn 1 should cache resp_abc");

    const calls = [];
    global.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.previous_response_id) {
        return new Response(JSON.stringify({
          error: {
            code: "previous_response_not_found",
            message: "previous response not found",
          },
        }), { status: 404, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        id: "resp_def",
        object: "response",
        model: "gpt-5.5",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "bye" }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [
          ...turn1Messages,
          { role: "assistant", content: "hello" },
          { role: "user", content: "bye" },
        ],
      }),
    }));

    assert.equal(calls.length, 2);
    assert.equal(calls[0].previous_response_id, "resp_abc");
    assert.equal(calls[0].input.length, 1, "first attempt should be trimmed");
    assert.equal(calls[1].previous_response_id, undefined);
    assert.equal(calls[1].input.length, 3, "retry should restore full input");
    assert.equal([...kv.store.values()].includes("resp_abc"), false, "stale response id should be deleted");
    assert.equal([...kv.store.values()].includes("resp_def"), true, "stateless retry response should refresh the chain");
  });

  it("retries stateless when previous_response_id rejects a tool output call_id", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const kv = makeInMemoryKv();
    setKvDriver(kv);

    global.fetch = async () => new Response(JSON.stringify({
      id: "resp_tool_call",
      object: "response",
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" }],
    }), { status: 200, headers: { "content-type": "application/json" } });

    const turn1Messages = [{ role: "user", content: "lookup" }];
    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", messages: turn1Messages }),
    }));
    assert.ok([...kv.store.values()].includes("resp_tool_call"), "turn 1 should cache the tool-call response id");

    const calls = [];
    global.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.previous_response_id) {
        return new Response(JSON.stringify({
          error: {
            message: "No tool call found for function call output with call_id call_1.",
            type: "invalid_request_error",
            param: "input",
            code: null,
          },
        }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        id: "resp_tool_done",
        object: "response",
        model: "gpt-5.5",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const { result: res, logs } = await captureConsoleLogs(async () => handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [
          ...turn1Messages,
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            }],
          },
          { role: "tool", tool_call_id: "call_1", content: "42" },
        ],
      }),
    })));

    assert.equal(res.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].previous_response_id, "resp_tool_call");
    assert.equal(calls[0].input.length, 1, "first attempt should send only the tool output");
    assert.equal(calls[0].input[0].type, "function_call_output");
    assert.equal(calls[1].previous_response_id, undefined);
    assert.equal(calls[1].input.length, 3, "retry should restore the full tool-call exchange");
    assert.equal(calls[1].input[1].type, "function_call");
    assert.equal(calls[1].input[2].type, "function_call_output");
    assert.match(logs, /OAI_TOOL_OUTPUT_RETRY status: 400 inputItems: 3/);
    assert.equal([...kv.store.values()].includes("resp_tool_done"), true, "stateless retry response should refresh the chain");
  });

  it("halo Responses cache mode sends tool outputs stateless without first trying previous_response_id", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "halo";
    const kv = makeInMemoryKv();
    setKvDriver(kv);

    global.fetch = async () => new Response(JSON.stringify({
      id: "resp_tool_call",
      object: "response",
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" }],
    }), { status: 200, headers: { "content-type": "application/json" } });

    const turn1Messages = [{ role: "user", content: "lookup" }];
    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "session_id": "halo-session-1" },
      body: JSON.stringify({ model: "gpt-5.5", messages: turn1Messages }),
    }));
    assert.ok([...kv.store.values()].includes("resp_tool_call"), "turn 1 should cache the tool-call response id");

    const calls = [];
    const sessions = [];
    global.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      sessions.push(new Headers(init.headers).get("Session_id"));
      assert.equal(body.previous_response_id, undefined, "halo mode should skip previous_response_id for tool-output turns");
      return new Response(JSON.stringify({
        id: "resp_tool_done",
        object: "response",
        model: "gpt-5.5",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const { result: res, logs } = await captureConsoleLogs(async () => handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "session_id": "halo-session-1" },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [
          ...turn1Messages,
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            }],
          },
          { role: "tool", tool_call_id: "call_1", content: "42" },
        ],
      }),
    })));

    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].previous_response_id, undefined);
    assert.equal(calls[0].input.length, 3, "halo mode should send the full tool-call exchange first");
    assert.equal(calls[0].input[1].type, "function_call");
    assert.equal(calls[0].input[2].type, "function_call_output");
    assert.match(calls[0].prompt_cache_key, /^halo_session_id_[0-9a-f]{32}$/);
    assert.deepEqual(sessions, ["halo-session-1"]);
    assert.match(logs, /OAI_RESP_HALO_TOOL_OUTPUT_STATELESS provider: openaicompat inputItems: 3 toolOutputs: 1/);
    assert.doesNotMatch(logs, /OAI_TOOL_OUTPUT_RETRY/);
    assert.equal([...kv.store.values()].includes("resp_tool_done"), true, "stateless retry response should refresh the chain");
  });

  it("halo Responses cache mode sends native input tool outputs stateless", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "halo";
    const kv = makeInMemoryKv();
    setKvDriver(kv);

    global.fetch = async () => new Response(JSON.stringify({
      id: "resp_native_tool_call",
      object: "response",
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" }],
    }), { status: 200, headers: { "content-type": "application/json" } });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "session_id": "halo-session-1" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: [{ role: "user", content: "lookup" }],
      }),
    }));
    assert.ok([...kv.store.values()].includes("resp_native_tool_call"), "turn 1 should cache the native tool-call response id");

    const calls = [];
    const sessions = [];
    global.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      sessions.push(new Headers(init.headers).get("Session_id"));
      assert.equal(body.previous_response_id, undefined, "halo mode should skip previous_response_id for native tool outputs");
      return new Response(JSON.stringify({
        id: "resp_native_tool_done",
        object: "response",
        model: "gpt-5.5",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const { result: res, logs } = await captureConsoleLogs(async () => handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "session_id": "halo-session-1" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: [
          { role: "user", content: "lookup" },
          { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "42" },
        ],
      }),
    })));

    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input.length, 3);
    assert.equal(calls[0].input[1].type, "function_call");
    assert.equal(calls[0].input[2].type, "function_call_output");
    assert.match(calls[0].prompt_cache_key, /^halo_session_id_[0-9a-f]{32}$/);
    assert.deepEqual(sessions, ["halo-session-1"]);
    assert.match(logs, /OAI_RESP_HALO_TOOL_OUTPUT_STATELESS provider: openaicompat inputItems: 3 toolOutputs: 1/);
    assert.doesNotMatch(logs, /OAI_TOOL_OUTPUT_RETRY/);
    assert.equal([...kv.store.values()].includes("resp_native_tool_done"), true, "native stateless response should refresh the chain");
  });

  it("does not apply the default tool-output retry in sub2api mode", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "sub2api";
    const kv = makeInMemoryKv();
    setKvDriver(kv);

    global.fetch = async () => new Response(JSON.stringify({
      id: "resp_tool_call",
      object: "response",
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" }],
    }), { status: 200, headers: { "content-type": "application/json" } });

    const turn1Messages = [{ role: "user", content: "lookup" }];
    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", messages: turn1Messages }),
    }));

    const calls = [];
    global.fetch = async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        error: {
          message: "No tool call found for function call output with call_id call_1.",
          type: "invalid_request_error",
          param: "input",
          code: null,
        },
      }), { status: 400, headers: { "content-type": "application/json" } });
    };

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [
          ...turn1Messages,
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            }],
          },
          { role: "tool", tool_call_id: "call_1", content: "42" },
        ],
      }),
    }));

    assert.equal(res.status, 400);
    assert.equal(calls.length, 1, "sub2api should not use the default-mode tool-output retry");
    assert.equal(calls[0].previous_response_id, "resp_tool_call");
  });

  it("sub2api mode expands native Responses trim to include matching function_call before tool outputs", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "sub2api";
    const kv = makeInMemoryKv();
    setKvDriver(kv);

    global.fetch = async () => new Response(JSON.stringify({
      id: "resp_tool_call",
      object: "response",
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" }],
    }), { status: 200, headers: { "content-type": "application/json" } });

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: [{ role: "user", content: "lookup" }],
      }),
    }));

    let captured = null;
    global.fetch = async (_url, init) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({
        id: "resp_done",
        object: "response",
        model: "gpt-5.5",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        input: [
          { role: "user", content: "lookup" },
          { type: "message", role: "assistant", content: "calling lookup" },
          { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "42" },
          { role: "user", content: "summarize" },
        ],
      }),
    }));

    assert.equal(captured.previous_response_id, "resp_tool_call");
    assert.equal(captured.input.length, 3);
    assert.equal(captured.input[0].type, "function_call");
    assert.equal(captured.input[1].type, "function_call_output");
    assert.equal(captured.input[2].role, "user");
  });

  it("maps Responses cached token usage into Chat Completions usage", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    global.fetch = async () => new Response(JSON.stringify({
      id: "resp_usage",
      object: "response",
      model: "gpt-4o",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        total_tokens: 110,
        input_tokens_details: { cached_tokens: 80 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    }));
    const body = await res.json();
    assert.equal(body.usage.prompt_tokens, 100);
    assert.equal(body.usage.completion_tokens, 10);
    assert.equal(body.usage.total_tokens, 110);
    assert.equal(body.usage.prompt_tokens_details.cached_tokens, 80);
  });

  it("emits stream usage when stream_options.include_usage is requested", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    const stream = [
      "event: response.created",
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_usage_stream\",\"status\":\"in_progress\",\"model\":\"gpt-4o\"}}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_usage_stream\",\"status\":\"completed\",\"model\":\"gpt-4o\",\"error\":null,\"usage\":{\"input_tokens\":50,\"output_tokens\":5,\"total_tokens\":55,\"input_tokens_details\":{\"cached_tokens\":40}}}}",
      "",
    ].join("\n");
    global.fetch = async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const res = await handler(new Request(PROVIDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    }));

    const body = await res.text();
    assert.match(body, /"choices":\[\]/);
    assert.match(body, /"prompt_tokens":50/);
    assert.match(body, /"cached_tokens":40/);
    assert.match(body, /data: \[DONE\]/);
  });
});
