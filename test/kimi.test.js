import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/proxy.js";
import { conversationHash } from "../lib/cache.js";
import { isKimiK3, isKimiThinkingModel, sanitizeKimiBody } from "../lib/kimi.js";
import { setKvDriver } from "../lib/kv.js";

describe("sanitizeKimiBody tool schema normalization", () => {
  function makeBody(params) {
    return {
      model: "kimi-k2.7-code",
      tools: [{ function: { name: "test_tool", parameters: params } }],
    };
  }

  it("rewrites #/definitions/X to #/$defs/<name>", () => {
    const body = makeBody({
      type: "object",
      definitions: { Foo: { type: "string" } },
      properties: { foo: { $ref: "#/definitions/Foo" } },
    });

    const changed = sanitizeKimiBody(body, "kimi-k2.7-code", "kimi");

    assert.equal(changed, true);
    assert.equal(body.tools[0].function.parameters.properties.foo.$ref.startsWith("#/$defs/"), true);
  });

  it("rewrites #/properties/X self-references", () => {
    const body = makeBody({
      type: "object",
      properties: {
        final_summary: { type: "string" },
        all: { allOf: [{ $ref: "#/properties/final_summary" }] },
      },
    });

    const changed = sanitizeKimiBody(body, "kimi-k2.7-code", "kimi");

    assert.equal(changed, true);
    assert.equal(body.tools[0].function.parameters.properties.all.allOf[0].$ref.startsWith("#/$defs/"), true);
  });

  it("handles recursive schemas without stack overflow", () => {
    const body = makeBody({
      type: "object",
      definitions: {
        Node: {
          type: "object",
          properties: { child: { $ref: "#/definitions/Node" } },
        },
      },
      properties: { root: { $ref: "#/definitions/Node" } },
    });

    assert.doesNotThrow(() => sanitizeKimiBody(body, "kimi-k2.7-code", "kimi"));
    assert.equal(body.tools[0].function.parameters.properties.root.$ref.startsWith("#/$defs/"), true);
  });

  it("does not corrupt $ref inside const/default/examples/enum", () => {
    const body = makeBody({
      type: "object",
      properties: {
        a: {
          type: "string",
          const: { $ref: "#/definitions/Foo" },
          default: { $ref: "#/definitions/Foo" },
          examples: [{ $ref: "#/definitions/Foo" }],
          enum: [{ $ref: "#/definitions/Foo" }],
        },
      },
    });

    sanitizeKimiBody(body, "kimi-k2.7-code", "kimi");

    const prop = body.tools[0].function.parameters.properties.a;
    assert.equal(prop.const.$ref, "#/definitions/Foo");
    assert.equal(prop.default.$ref, "#/definitions/Foo");
    assert.equal(prop.examples[0].$ref, "#/definitions/Foo");
    assert.equal(prop.enum[0].$ref, "#/definitions/Foo");
  });

  it("removes external refs and reports changed", () => {
    const body = makeBody({
      type: "object",
      properties: {
        local: { $ref: "#/definitions/X" },
        remote: { $ref: "https://example.com/schema.json" },
      },
      definitions: { X: { type: "boolean" } },
    });

    const changed = sanitizeKimiBody(body, "kimi-k2.7-code", "kimi");

    assert.equal(changed, true);
    assert.equal(body.tools[0].function.parameters.properties.local.$ref.startsWith("#/$defs/"), true);
    assert.equal(body.tools[0].function.parameters.properties.remote.$ref, undefined);
  });

  it("is idempotent", () => {
    const body = makeBody({
      type: "object",
      definitions: { Foo: { type: "string" } },
      properties: { foo: { $ref: "#/definitions/Foo" } },
    });

    sanitizeKimiBody(body, "kimi-k2.7-code", "kimi");
    const first = JSON.stringify(body.tools[0].function.parameters);
    sanitizeKimiBody(body, "kimi-k2.7-code", "kimi");
    const second = JSON.stringify(body.tools[0].function.parameters);

    assert.equal(first, second);
  });

  it("normalizes tools for provider=kimi even when model name is not kimi-*", () => {
    const body = {
      model: "moonshot-myapp",
      tools: [{
        function: {
          name: "t",
          parameters: {
            type: "object",
            definitions: { Foo: { type: "string" } },
            properties: { foo: { $ref: "#/definitions/Foo" } },
          },
        },
      }],
    };

    const changed = sanitizeKimiBody(body, "moonshot-myapp", "kimi");

    assert.equal(changed, true);
    assert.equal(body.tools[0].function.parameters.properties.foo.$ref.startsWith("#/$defs/"), true);
  });

  it("leaves non-kimi models alone when providerKey is omitted", () => {
    const body = {
      model: "moonshot-myapp",
      tools: [{
        function: {
          name: "t",
          parameters: {
            type: "object",
            definitions: { Foo: { type: "string" } },
            properties: { foo: { $ref: "#/definitions/Foo" } },
          },
        },
      }],
    };

    const changed = sanitizeKimiBody(body, "moonshot-myapp");

    assert.equal(changed, false);
    assert.equal(body.tools[0].function.parameters.properties.foo.$ref, "#/definitions/Foo");
  });

  it("does not add empty $defs to plain schemas", () => {
    const body = makeBody({
      type: "object",
      properties: { foo: { type: "string" } },
    });

    const changed = sanitizeKimiBody(body, "kimi-k2.7-code", "kimi");

    assert.equal(changed, false);
    assert.equal(body.tools[0].function.parameters.$defs, undefined);
  });
});

describe("sanitizeKimiBody model contracts", () => {
  it("recognizes only the exact Kimi K3 model ID", () => {
    assert.equal(isKimiK3("kimi-k3"), true);
    assert.equal(isKimiK3(" KIMI-K3 "), true);
    assert.equal(isKimiK3("kimi-k3-preview"), false);
    assert.equal(isKimiThinkingModel("kimi-k3"), true);
  });

  it("applies the K3 request contract without K2 token or tool-choice rewrites", () => {
    const namedToolChoice = {
      type: "function",
      function: { name: "inspect_repository" },
    };
    const body = {
      model: "kimi-k3",
      temperature: 0.7,
      top_p: 0.8,
      n: 2,
      presence_penalty: 0.2,
      frequency_penalty: 0.3,
      reasoning_effort: "low",
      thinking: { type: "enabled", keep: "all" },
      tool_choice: namedToolChoice,
      max_completion_tokens: 1024,
    };

    const changed = sanitizeKimiBody(body, "kimi-k3", "kimi");

    assert.equal(changed, true);
    assert.equal(body.temperature, undefined);
    assert.equal(body.top_p, undefined);
    assert.equal(body.n, undefined);
    assert.equal(body.presence_penalty, undefined);
    assert.equal(body.frequency_penalty, undefined);
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, "max");
    assert.deepEqual(body.tool_choice, namedToolChoice);
    assert.equal(body.max_completion_tokens, 1024);
    assert.equal(body.max_tokens, undefined);
  });

  it("preserves required tool choice and the documented K3 maximum output limit", () => {
    const body = {
      model: "kimi-k3",
      reasoning_effort: "max",
      tool_choice: "required",
      max_completion_tokens: 1_048_576,
    };

    const changed = sanitizeKimiBody(body, "kimi-k3", "kimi");

    assert.equal(changed, false);
    assert.equal(body.tool_choice, "required");
    assert.equal(body.max_completion_tokens, 1_048_576);
    assert.equal(body.max_tokens, undefined);
  });

  it("keeps K2.7 Code fixed-parameter, tool-choice, token-floor, and thinking behavior", () => {
    const body = {
      model: "kimi-k2.7-code",
      temperature: 0.7,
      top_p: 0.8,
      n: 2,
      presence_penalty: 0.2,
      frequency_penalty: 0.3,
      reasoning_effort: "max",
      thinking: { type: "disabled" },
      tool_choice: "required",
      max_completion_tokens: 4096,
    };

    sanitizeKimiBody(body, "kimi-k2.7-code", "kimi");

    assert.equal(body.temperature, undefined);
    assert.equal(body.top_p, undefined);
    assert.equal(body.n, undefined);
    assert.equal(body.presence_penalty, undefined);
    assert.equal(body.frequency_penalty, undefined);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.thinking, undefined);
    assert.equal(body.tool_choice, "auto");
    assert.equal(body.max_completion_tokens, undefined);
    assert.equal(body.max_tokens, 16_000);
  });

  it("keeps K2.6 preserved thinking while honoring explicit disablement", () => {
    const enabledBody = {
      model: "kimi-k2.6",
      thinking: { type: "enabled" },
      max_tokens: 20_000,
    };
    const disabledBody = {
      model: "kimi-k2.6",
      thinking: { type: "disabled" },
      max_tokens: 20_000,
    };

    sanitizeKimiBody(enabledBody, "kimi-k2.6", "kimi");
    sanitizeKimiBody(disabledBody, "kimi-k2.6", "kimi");

    assert.deepEqual(enabledBody.thinking, { type: "enabled", keep: "all" });
    assert.deepEqual(disabledBody.thinking, { type: "disabled" });
  });

  it("keeps K2.5 thinking enabled without the unsupported keep field", () => {
    const body = {
      model: "kimi-k2.5",
      thinking: { type: "enabled", keep: "all" },
      max_tokens: 20_000,
    };

    sanitizeKimiBody(body, "kimi-k2.5", "kimi");

    assert.deepEqual(body.thinking, { type: "enabled" });
  });
});

const KIMI_PROVIDER_URL = "http://localhost/api/proxy?provider=kimi&path=chat/completions";
const UNIFIED_PROXY_URL = "http://localhost/api/proxy?path=chat/completions";
const KIMI_ENV_KEYS = [
  "KIMI_API_KEY",
  "CURSORPROXY_API_KEY",
  "KV_RETRY_DELAYS_MS",
  "STREAM_TIMEOUT_SECONDS",
];

function makeInMemoryKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async del(key) {
      store.delete(key);
    },
  };
}

function makeKimiCompletion({
  id = "chatcmpl_kimi_k3",
  model = "kimi-k3",
  content = "Kimi response",
  reasoningContent,
} = {}) {
  return {
    id,
    object: "chat.completion",
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content,
        ...(reasoningContent == null ? {} : { reasoning_content: reasoningContent }),
      },
      finish_reason: "stop",
    }],
  };
}

function mockKimiJsonFetch(responseFactory = () => makeKimiCompletion()) {
  const calls = [];
  global.fetch = async (url, init) => {
    const capturedCall = {
      url,
      headers: new Headers(init.headers),
      body: JSON.parse(init.body),
    };
    calls.push(capturedCall);
    const responseBody = responseFactory(capturedCall, calls.length - 1);
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return calls;
}

async function invokeKimi(body, url = KIMI_PROVIDER_URL) {
  return handler(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("Kimi K3 handler integration", () => {
  let originalFetch;
  let originalEnvironment;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnvironment = {};
    for (const environmentKey of KIMI_ENV_KEYS) {
      originalEnvironment[environmentKey] = process.env[environmentKey];
    }
    process.env.KIMI_API_KEY = "sk-kimi-test";
    process.env.KV_RETRY_DELAYS_MS = "0";
    process.env.STREAM_TIMEOUT_SECONDS = "0";
    delete process.env.CURSORPROXY_API_KEY;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const environmentKey of KIMI_ENV_KEYS) {
      if (originalEnvironment[environmentKey] === undefined) {
        delete process.env[environmentKey];
      } else {
        process.env[environmentKey] = originalEnvironment[environmentKey];
      }
    }
    setKvDriver(null);
  });

  it("routes the public K3 model and sends the native Moonshot request contract", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const calls = mockKimiJsonFetch(() => makeKimiCompletion({
      id: "chatcmpl_public_k3",
      content: "done",
      reasoningContent: "private K3 reasoning",
    }));
    const messages = [{ role: "user", content: "Solve this problem." }];

    const response = await invokeKimi({
      model: "cursorproxy/kimi-k3",
      messages,
      temperature: 0.7,
      top_p: 0.8,
      n: 2,
      presence_penalty: 0.2,
      frequency_penalty: 0.3,
      reasoning_effort: "low",
      thinking: { type: "enabled", keep: "all" },
      tool_choice: "required",
      max_completion_tokens: 1_048_576,
    }, UNIFIED_PROXY_URL);
    const responseBody = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.moonshot.ai/v1/chat/completions");
    assert.equal(calls[0].headers.get("authorization"), "Bearer sk-kimi-test");
    assert.equal(calls[0].headers.get("host"), "api.moonshot.ai");
    assert.equal(calls[0].headers.get("accept-encoding"), "identity");
    assert.equal(calls[0].body.model, "kimi-k3");
    assert.equal(calls[0].body.temperature, undefined);
    assert.equal(calls[0].body.top_p, undefined);
    assert.equal(calls[0].body.n, undefined);
    assert.equal(calls[0].body.presence_penalty, undefined);
    assert.equal(calls[0].body.frequency_penalty, undefined);
    assert.equal(calls[0].body.thinking, undefined);
    assert.equal(calls[0].body.reasoning_effort, "max");
    assert.equal(calls[0].body.tool_choice, "required");
    assert.equal(calls[0].body.max_completion_tokens, 1_048_576);
    assert.equal(calls[0].body.max_tokens, undefined);
    assert.equal(responseBody.id, "chatcmpl_public_k3");
    assert.equal(responseBody.model, "cursorproxy/kimi-k3");
    assert.equal(responseBody.choices[0].message.content, "done");
    assert.equal(responseBody.choices[0].message.reasoning_content, undefined);

    const expectedCacheKey = await conversationHash(
      messages,
      messages.length,
      "kimi:kimi-k3:anon",
    );
    assert.equal(kvDriver.store.get(expectedCacheKey), "private K3 reasoning");
  });

  it("defaults model-less Kimi route requests to K3", async () => {
    const calls = mockKimiJsonFetch();

    const response = await invokeKimi({
      messages: [{ role: "user", content: "Hello." }],
    });
    await response.text();

    assert.equal(response.status, 200);
    assert.equal(calls[0].body.model, "kimi-k3");
    assert.equal(calls[0].body.reasoning_effort, "max");
  });

  it("preserves named tool choice and base64 vision input for native K3", async () => {
    const calls = mockKimiJsonFetch();
    const imageContent = [
      { type: "text", text: "Describe this image." },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,a2ltaS1rMw==" },
      },
    ];
    const namedToolChoice = {
      type: "function",
      function: { name: "record_description" },
    };

    const response = await invokeKimi({
      model: "kimi-k3",
      messages: [{ role: "user", content: imageContent }],
      tools: [{
        type: "function",
        function: {
          name: "record_description",
          parameters: {
            type: "object",
            properties: { description: { type: "string" } },
            required: ["description"],
          },
        },
      }],
      tool_choice: namedToolChoice,
      max_completion_tokens: 131_072,
    }, UNIFIED_PROXY_URL);
    await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(calls[0].body.tool_choice, namedToolChoice);
    assert.deepEqual(calls[0].body.messages[0].content, imageContent);
    assert.equal(calls[0].body.max_completion_tokens, 131_072);
  });

  it("restores complete K3 reasoning on the next turn", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const calls = mockKimiJsonFetch((_capturedCall, callIndex) => {
      if (callIndex === 0) {
        return makeKimiCompletion({
          content: "The answer is 4.",
          reasoningContent: "Add two and two.",
        });
      }
      return makeKimiCompletion({ content: "Because 2 + 2 equals 4." });
    });
    const firstTurnMessages = [{ role: "user", content: "What is 2 + 2?" }];

    const firstResponse = await invokeKimi({
      model: "kimi-k3",
      messages: firstTurnMessages,
    }, UNIFIED_PROXY_URL);
    const firstResponseBody = await firstResponse.json();
    assert.equal(firstResponseBody.choices[0].message.reasoning_content, undefined);

    const secondResponse = await invokeKimi({
      model: "kimi-k3",
      messages: [
        ...firstTurnMessages,
        { role: "assistant", content: "The answer is 4." },
        { role: "user", content: "Explain why." },
      ],
    }, UNIFIED_PROXY_URL);
    await secondResponse.text();

    assert.equal(secondResponse.status, 200);
    assert.equal(calls[1].body.messages[1].reasoning_content, "Add two and two.");
  });

  it("isolates K3 reasoning from legacy K2 cache keys without invalidating K2", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const firstTurnMessages = [{ role: "user", content: "Shared prompt." }];
    const legacyK2CacheKey = await conversationHash(
      firstTurnMessages,
      firstTurnMessages.length,
      "kimi:anon",
    );
    kvDriver.store.set(legacyK2CacheKey, "legacy K2 reasoning");
    const calls = mockKimiJsonFetch((_capturedCall, callIndex) => makeKimiCompletion({
      model: callIndex === 0 ? "kimi-k3" : "kimi-k2.7-code",
      content: "continued",
    }));
    const continuedMessages = [
      ...firstTurnMessages,
      { role: "assistant", content: "Prior answer." },
      { role: "user", content: "Continue." },
    ];

    const k3Response = await invokeKimi({
      model: "kimi-k3",
      messages: continuedMessages,
    }, UNIFIED_PROXY_URL);
    await k3Response.text();
    const k2Response = await invokeKimi({
      model: "kimi-k2.7-code",
      messages: continuedMessages,
    }, UNIFIED_PROXY_URL);
    await k2Response.text();

    assert.equal(
      calls[0].body.messages[1].reasoning_content,
      "(prior reasoning unavailable)",
    );
    assert.notEqual(calls[0].body.messages[1].reasoning_content, "legacy K2 reasoning");
    assert.equal(calls[1].body.messages[1].reasoning_content, "legacy K2 reasoning");
    assert.equal(kvDriver.store.get(legacyK2CacheKey), "legacy K2 reasoning");
  });

  it("strips streamed K3 reasoning from the client while caching it for restoration", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const messages = [{ role: "user", content: "Stream an answer." }];
    const streamBody = [
      `data: ${JSON.stringify({
        id: "chatcmpl_k3_stream",
        object: "chat.completion.chunk",
        model: "kimi-k3",
        choices: [{
          index: 0,
          delta: { role: "assistant", reasoning_content: "streamed K3 reasoning" },
          finish_reason: null,
        }],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl_k3_stream",
        object: "chat.completion.chunk",
        model: "kimi-k3",
        choices: [{
          index: 0,
          delta: { content: "Visible answer." },
          finish_reason: "stop",
        }],
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    global.fetch = async () => new Response(streamBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const response = await invokeKimi({
      model: "kimi-k3",
      messages,
      stream: true,
    }, UNIFIED_PROXY_URL);
    const clientStream = await response.text();

    assert.equal(response.status, 200);
    assert.match(clientStream, /chatcmpl_k3_stream/);
    assert.match(clientStream, /Visible answer\./);
    assert.match(clientStream, /data: \[DONE\]/);
    assert.doesNotMatch(clientStream, /streamed K3 reasoning|reasoning_content/);

    const expectedCacheKey = await conversationHash(
      messages,
      messages.length,
      "kimi:kimi-k3:anon",
    );
    assert.equal(kvDriver.store.get(expectedCacheKey), "streamed K3 reasoning");
  });
});
