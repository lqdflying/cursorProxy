import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/proxy.js";
import { conversationHash } from "../lib/cache.js";
import { rewriteEdgeOneProxyUrl } from "../lib/edgeone.js";
import { isKimiK3, sanitizeKimiBody } from "../lib/kimi.js";
import { setKvDriver } from "../lib/kv.js";
import { configuredModelIds, providerFromModel } from "../lib/models.js";
import {
  TOKENROUTER_DEEPSEEK_V4_FLASH,
  TOKENROUTER_DEEPSEEK_V4_PRO,
  TOKENROUTER_GLM_52,
  TOKENROUTER_GLM_53,
  TOKENROUTER_KIMI_K3,
  TOKENROUTER_QWEN_38_MAX,
  isTokenRouterDeepSeekV4,
  isTokenRouterGlm52,
  isTokenRouterKimiK3,
  isTokenRouterNativeModel,
  isTokenRouterQwen38Max,
  normalizeTokenRouterDeveloperRole,
  resolveTokenRouterModel,
  sanitizeTokenRouterGlmBody,
  sanitizeTokenRouterQwenBody,
  tokenrouterRequiresVisionBridge,
} from "../lib/tokenrouter.js";
import { requiresVisionBridge } from "../lib/vision-bridge.js";

const TOKENROUTER_PROVIDER_URL = "http://localhost/api/proxy?provider=tokenrouter&path=chat/completions";
const UNIFIED_PROXY_URL = "http://localhost/api/proxy?path=chat/completions";
const KIMI_PROVIDER_URL = "http://localhost/api/proxy?provider=kimi&path=chat/completions";
const DEEPSEEK_PROVIDER_URL = "http://localhost/api/proxy?provider=deepseek&path=chat/completions";
const MODELS_URL = "http://localhost/api/proxy?path=models";

const TOKENROUTER_ENV_KEYS = [
  "TOKENROUTER_API_KEY",
  "KIMI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MINIMAX_API_KEY",
  "CURSORPROXY_API_KEY",
  "CURSORPROXY_MODELS",
  "UPSTREAM_TOKENROUTER",
  "DEBUG",
  "KV_RETRY_DELAYS_MS",
  "STREAM_TIMEOUT_SECONDS",
  "VISION_TIMEOUT_MS",
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

function makeCompletion({
  id = "chatcmpl_tokenrouter",
  model = TOKENROUTER_KIMI_K3,
  content = "ok",
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

function mockJsonFetch(responseFactory = () => makeCompletion()) {
  const calls = [];
  global.fetch = async (url, init) => {
    const capturedCall = {
      url: String(url),
      headers: new Headers(init.headers),
      body: init.body ? JSON.parse(init.body) : null,
    };
    calls.push(capturedCall);
    if (capturedCall.url.includes("coding_plan/vlm")) {
      return new Response(JSON.stringify({ content: "a screenshot of a terminal" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const responseBody = responseFactory(capturedCall, calls.length - 1);
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return calls;
}

async function invoke(body, url = TOKENROUTER_PROVIDER_URL) {
  return handler(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("TokenRouter helpers", () => {
  it("recognizes first-version family prefixes including suffixes", () => {
    assert.equal(isTokenRouterNativeModel(TOKENROUTER_KIMI_K3), true);
    assert.equal(isTokenRouterNativeModel(TOKENROUTER_DEEPSEEK_V4_PRO), true);
    assert.equal(isTokenRouterNativeModel(TOKENROUTER_DEEPSEEK_V4_FLASH), true);
    assert.equal(isTokenRouterNativeModel(TOKENROUTER_QWEN_38_MAX), true);
    assert.equal(isTokenRouterNativeModel(TOKENROUTER_GLM_52), true);
    assert.equal(isTokenRouterNativeModel(TOKENROUTER_GLM_53), true);
    assert.equal(isTokenRouterNativeModel("Qwen/Qwen3.8-Max"), true);
    assert.equal(isTokenRouterNativeModel("moonshotai/kimi-k3-free"), true);
    assert.equal(isTokenRouterNativeModel("deepseek/deepseek-v4-pro-0813-free"), true);
    assert.equal(isTokenRouterNativeModel("qwen/qwen3.8-max-free"), true);
    assert.equal(isTokenRouterNativeModel("z-ai/glm-5.2-free"), true);
    assert.equal(isTokenRouterNativeModel("z-ai/glm-5.3-free"), true);
    assert.equal(isTokenRouterNativeModel("deepseek/deepseek-v4-flash"), true);
    assert.equal(isTokenRouterNativeModel("deepseek/deepseek-v4-pro-0901"), true);
    assert.equal(isTokenRouterNativeModel("kimi-k3"), false);
    assert.equal(isTokenRouterNativeModel("qwen3.8-max"), false);
    assert.equal(isTokenRouterNativeModel("qwen/qwen3.7-max"), false);
    assert.equal(isTokenRouterNativeModel("moonshotai/kimi-k2.7-code"), false);
    assert.equal(isTokenRouterNativeModel("z-ai/glm-4.6"), false);
    assert.equal(isTokenRouterNativeModel("glm-5.2"), false);
  });

  it("strips the tokenrouter/ disambiguation prefix without rewriting the catalog ID", () => {
    assert.equal(resolveTokenRouterModel("tokenrouter/moonshotai/kimi-k3"), TOKENROUTER_KIMI_K3);
    assert.equal(resolveTokenRouterModel(TOKENROUTER_KIMI_K3), TOKENROUTER_KIMI_K3);
    assert.equal(resolveTokenRouterModel("Qwen/Qwen3.8-Max"), "Qwen/Qwen3.8-Max");
    assert.equal(resolveTokenRouterModel("tokenrouter/Qwen/Qwen3.8-Max"), "Qwen/Qwen3.8-Max");
    assert.equal(resolveTokenRouterModel("qwen/qwen3.8-max-free"), "qwen/qwen3.8-max-free");
    assert.equal(resolveTokenRouterModel("tokenrouter/qwen/qwen3.8-max-free"), "qwen/qwen3.8-max-free");
    assert.equal(resolveTokenRouterModel(TOKENROUTER_GLM_52), TOKENROUTER_GLM_52);
    assert.equal(resolveTokenRouterModel("Z-AI/GLM-5.2"), "Z-AI/GLM-5.2");
    assert.equal(resolveTokenRouterModel(TOKENROUTER_GLM_53), TOKENROUTER_GLM_53);
    assert.equal(resolveTokenRouterModel("qwen/qwen3.7-max"), "qwen/qwen3.7-max");
    assert.equal(resolveTokenRouterModel(""), "");
  });

  it("classifies K3 vs DeepSeek V4 vs Qwen vs GLM family vision and policy", () => {
    assert.equal(isTokenRouterKimiK3(TOKENROUTER_KIMI_K3), true);
    assert.equal(isTokenRouterKimiK3("moonshotai/kimi-k3-free"), true);
    assert.equal(isTokenRouterKimiK3("moonshotai/kimi-k2.7-code"), false);
    assert.equal(isTokenRouterDeepSeekV4(TOKENROUTER_DEEPSEEK_V4_PRO), true);
    assert.equal(isTokenRouterDeepSeekV4(TOKENROUTER_DEEPSEEK_V4_FLASH), true);
    assert.equal(isTokenRouterDeepSeekV4("deepseek/deepseek-v4-pro-0813-free"), true);
    assert.equal(isTokenRouterDeepSeekV4("deepseek/deepseek-v4-flash"), true);
    assert.equal(isTokenRouterDeepSeekV4(TOKENROUTER_GLM_52), false);
    assert.equal(isTokenRouterDeepSeekV4(TOKENROUTER_QWEN_38_MAX), false);
    assert.equal(isTokenRouterQwen38Max(TOKENROUTER_QWEN_38_MAX), true);
    assert.equal(isTokenRouterQwen38Max("qwen/qwen3.8-max-free"), true);
    assert.equal(isTokenRouterQwen38Max("qwen3.8-max"), false);
    assert.equal(isTokenRouterGlm52(TOKENROUTER_GLM_52), true);
    assert.equal(isTokenRouterGlm52(TOKENROUTER_GLM_53), true);
    assert.equal(isTokenRouterGlm52("z-ai/glm-5.3-free"), true);
    assert.equal(isTokenRouterGlm52("glm-5.2"), false);
    assert.equal(tokenrouterRequiresVisionBridge(TOKENROUTER_GLM_52), true);
    assert.equal(tokenrouterRequiresVisionBridge(TOKENROUTER_GLM_53), true);
    assert.equal(tokenrouterRequiresVisionBridge("z-ai/glm-5.2-free"), true);
    assert.equal(tokenrouterRequiresVisionBridge(TOKENROUTER_KIMI_K3), false);
    assert.equal(tokenrouterRequiresVisionBridge(TOKENROUTER_DEEPSEEK_V4_FLASH), true);
    assert.equal(tokenrouterRequiresVisionBridge(TOKENROUTER_QWEN_38_MAX), false);
    assert.equal(requiresVisionBridge("tokenrouter", TOKENROUTER_KIMI_K3), false);
    assert.equal(requiresVisionBridge("tokenrouter", TOKENROUTER_DEEPSEEK_V4_PRO), true);
    assert.equal(requiresVisionBridge("tokenrouter", TOKENROUTER_GLM_52), true);
    assert.equal(requiresVisionBridge("tokenrouter", TOKENROUTER_GLM_53), true);
    assert.equal(requiresVisionBridge("tokenrouter", TOKENROUTER_QWEN_38_MAX), false);
    assert.equal(requiresVisionBridge("deepseek", "deepseek-v4-flash"), true);
  });

  it("converts developer roles to system without touching other turns", () => {
    const parsedBody = {
      messages: [
        { role: "developer", content: "be terse" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    };
    assert.equal(normalizeTokenRouterDeveloperRole(parsedBody), true);
    assert.equal(parsedBody.messages[0].role, "system");
    assert.equal(parsedBody.messages[1].role, "user");
    assert.equal(normalizeTokenRouterDeveloperRole(parsedBody), false);
  });

  it("applies the K3 sanitizer to the TokenRouter-qualified ID", () => {
    const body = {
      model: TOKENROUTER_KIMI_K3,
      temperature: 0.2,
      thinking: { type: "enabled" },
      reasoning_effort: "low",
      tool_choice: "required",
      max_completion_tokens: 4096,
    };
    assert.equal(isKimiK3(TOKENROUTER_KIMI_K3), true);
    assert.equal(sanitizeKimiBody(body, TOKENROUTER_KIMI_K3, "tokenrouter"), true);
    assert.equal(body.temperature, undefined);
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, "max");
    assert.equal(body.tool_choice, "required");
    assert.equal(body.max_completion_tokens, 4096);
  });

  it("strips Cursor thinking and clamps Qwen reasoning_effort without DashScope extras", () => {
    const body = {
      model: TOKENROUTER_QWEN_38_MAX,
      temperature: 0.2,
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    };
    assert.equal(sanitizeTokenRouterQwenBody(body), true);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, "xhigh");
    assert.equal(body.enable_thinking, undefined);
    assert.equal(body.preserve_thinking, undefined);

    const dropped = { reasoning_effort: "none" };
    assert.equal(sanitizeTokenRouterQwenBody(dropped), true);
    assert.equal(dropped.reasoning_effort, undefined);

    const objectEffort = JSON.parse('{"reasoning_effort":{"toString":"x"}}');
    assert.doesNotThrow(() => sanitizeTokenRouterQwenBody(objectEffort));
    assert.equal(objectEffort.reasoning_effort, undefined);

    const arrayEffort = { reasoning_effort: ["max"] };
    assert.equal(sanitizeTokenRouterQwenBody(arrayEffort), true);
    assert.equal(arrayEffort.reasoning_effort, undefined);
  });

  it("strips Cursor thinking and forwards valid GLM reasoning_effort without GLM-native fields", () => {
    const body = {
      model: TOKENROUTER_GLM_52,
      temperature: 0.2,
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      max_completion_tokens: 8192,
    };
    assert.equal(sanitizeTokenRouterGlmBody(body), true);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, "high");
    assert.equal(body.max_completion_tokens, 8192);
    assert.equal(body.tool_stream, undefined);
    assert.equal(body.max_tokens, undefined);

    for (const effort of ["max", "xhigh", "high", "medium", "low", "minimal", "none"]) {
      const kept = { reasoning_effort: effort };
      sanitizeTokenRouterGlmBody(kept);
      assert.equal(kept.reasoning_effort, effort, `effort ${effort} must be forwarded`);
    }

    const invalid = { reasoning_effort: "foo" };
    assert.equal(sanitizeTokenRouterGlmBody(invalid), true);
    assert.equal(invalid.reasoning_effort, undefined);

    const numeric = { reasoning_effort: 123 };
    assert.doesNotThrow(() => sanitizeTokenRouterGlmBody(numeric));
    assert.equal(numeric.reasoning_effort, undefined);

    const objectEffort = JSON.parse('{"reasoning_effort":{"toString":"x"}}');
    assert.doesNotThrow(() => sanitizeTokenRouterGlmBody(objectEffort));
    assert.equal(objectEffort.reasoning_effort, undefined);

    // Inbound GLM-native `tool_stream` (e.g. copied from a native GLM body or
    // a Z.AI-shaped SDK replay) must be stripped on this non-native host.
    const withToolStream = {
      model: TOKENROUTER_GLM_52,
      tool_stream: true,
      stream: true,
      tools: [{ type: "function", function: { name: "x", parameters: { type: "object" } } }],
      reasoning_effort: "medium",
    };
    assert.equal(sanitizeTokenRouterGlmBody(withToolStream), true);
    assert.equal(withToolStream.tool_stream, undefined);
    assert.equal(withToolStream.thinking, undefined);
    assert.equal(withToolStream.reasoning_effort, "medium");
    assert.equal(Array.isArray(withToolStream.tools), true);
  });
});

describe("TokenRouter provider routing", () => {
  it("routes exact and public TokenRouter IDs before native kimi/deepseek", () => {
    assert.equal(providerFromModel(TOKENROUTER_KIMI_K3), "tokenrouter");
    assert.equal(providerFromModel("cursorproxy/" + TOKENROUTER_KIMI_K3), "tokenrouter");
    assert.equal(providerFromModel("tokenrouter/" + TOKENROUTER_KIMI_K3), "tokenrouter");
    assert.equal(providerFromModel("cursorproxy/tokenrouter/" + TOKENROUTER_DEEPSEEK_V4_PRO), "tokenrouter");
    assert.equal(providerFromModel(TOKENROUTER_DEEPSEEK_V4_FLASH), "tokenrouter");
    assert.equal(providerFromModel(TOKENROUTER_QWEN_38_MAX), "tokenrouter");
    assert.equal(providerFromModel("cursorproxy/" + TOKENROUTER_QWEN_38_MAX), "tokenrouter");
    assert.equal(providerFromModel("tokenrouter/" + TOKENROUTER_QWEN_38_MAX), "tokenrouter");
    assert.equal(providerFromModel(TOKENROUTER_GLM_52), "tokenrouter");
    assert.equal(providerFromModel("cursorproxy/" + TOKENROUTER_GLM_52), "tokenrouter");
    assert.equal(providerFromModel("tokenrouter/" + TOKENROUTER_GLM_52), "tokenrouter");
    assert.equal(providerFromModel(TOKENROUTER_GLM_53), "tokenrouter");
    assert.equal(providerFromModel("qwen/qwen3.8-max-free"), "tokenrouter");
    assert.equal(providerFromModel("deepseek/deepseek-v4-pro-0813-free"), "tokenrouter");
    assert.equal(providerFromModel("moonshotai/kimi-k3-free"), "tokenrouter");
    assert.equal(providerFromModel("deepseek/deepseek-v4-flash"), "tokenrouter");
  });

  it("does not steal native Kimi, DeepSeek, or GLM IDs", () => {
    assert.equal(providerFromModel("kimi-k3"), "kimi");
    assert.equal(providerFromModel("cursorproxy/kimi-k3"), "kimi");
    assert.equal(providerFromModel("deepseek-v4-flash"), "deepseek");
    assert.equal(providerFromModel("deepseek-v4-pro"), "deepseek");
    assert.equal(providerFromModel("cursorproxy/deepseek-v4-flash"), "deepseek");
    assert.equal(providerFromModel("glm-5.2"), "glm");
    assert.equal(providerFromModel("cursorproxy/glm-5.2"), "glm");
  });

  it("does not treat unknown slash IDs as TokenRouter", () => {
    assert.equal(providerFromModel("moonshotai/kimi-k2.7-code"), null);
    assert.equal(providerFromModel("openai/gpt-5.5"), null);
    assert.equal(providerFromModel("qwen3.8-max"), null);
    assert.equal(providerFromModel("qwen/qwen3.7-max"), null);
    assert.equal(providerFromModel("z-ai/glm-4.6"), null);
  });

  it("preserves nested slashes in discovery IDs", () => {
    const previous = process.env.CURSORPROXY_MODELS;
    process.env.CURSORPROXY_MODELS = [
      TOKENROUTER_KIMI_K3,
      TOKENROUTER_DEEPSEEK_V4_PRO,
      TOKENROUTER_DEEPSEEK_V4_FLASH,
      TOKENROUTER_QWEN_38_MAX,
      TOKENROUTER_GLM_52,
      TOKENROUTER_GLM_53,
    ].join(",");
    try {
      assert.deepEqual(configuredModelIds(), [
        "cursorproxy/" + TOKENROUTER_KIMI_K3,
        "cursorproxy/" + TOKENROUTER_DEEPSEEK_V4_PRO,
        "cursorproxy/" + TOKENROUTER_DEEPSEEK_V4_FLASH,
        "cursorproxy/" + TOKENROUTER_QWEN_38_MAX,
        "cursorproxy/" + TOKENROUTER_GLM_52,
        "cursorproxy/" + TOKENROUTER_GLM_53,
      ]);
    } finally {
      if (previous === undefined) delete process.env.CURSORPROXY_MODELS;
      else process.env.CURSORPROXY_MODELS = previous;
    }
  });

  it("rewrites the EdgeOne TokenRouter route", () => {
    const rewritten = rewriteEdgeOneProxyUrl(
      new Request("https://example.com/tokenrouter/v1/chat/completions"),
      "tokenrouter",
    );
    const url = new URL(rewritten);
    assert.equal(url.pathname, "/api/proxy");
    assert.equal(url.searchParams.get("provider"), "tokenrouter");
    assert.equal(url.searchParams.get("path"), "chat/completions");
  });
});

describe("TokenRouter handler integration", () => {
  let originalFetch;
  let originalEnvironment;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnvironment = {};
    for (const key of TOKENROUTER_ENV_KEYS) {
      originalEnvironment[key] = process.env[key];
    }
    process.env.TOKENROUTER_API_KEY = "sk-tokenrouter-test";
    process.env.KIMI_API_KEY = "sk-kimi-test";
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-test";
    process.env.MINIMAX_API_KEY = "sk-minimax-test";
    process.env.KV_RETRY_DELAYS_MS = "0";
    process.env.STREAM_TIMEOUT_SECONDS = "0";
    process.env.VISION_TIMEOUT_MS = "0";
    delete process.env.CURSORPROXY_API_KEY;
    delete process.env.UPSTREAM_TOKENROUTER;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const key of TOKENROUTER_ENV_KEYS) {
      if (originalEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnvironment[key];
    }
    setKvDriver(null);
  });

  it("forwards first-version catalog IDs with bearer auth and the client catalog name", async () => {
    const calls = mockJsonFetch();
    const models = [
      TOKENROUTER_KIMI_K3,
      TOKENROUTER_DEEPSEEK_V4_PRO,
      TOKENROUTER_DEEPSEEK_V4_FLASH,
      TOKENROUTER_QWEN_38_MAX,
      TOKENROUTER_GLM_52,
      TOKENROUTER_GLM_53,
    ];
    for (const model of models) {
      const response = await invoke({
        model,
        messages: [{ role: "user", content: "ping" }],
      }, UNIFIED_PROXY_URL);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.model, "cursorproxy/" + model);
    }

    assert.equal(calls.length, models.length);
    for (const [index, model] of models.entries()) {
      assert.equal(calls[index].url, "https://api.tokenrouter.com/v1/chat/completions");
      assert.equal(calls[index].headers.get("authorization"), "Bearer sk-tokenrouter-test");
      assert.equal(calls[index].headers.get("host"), "api.tokenrouter.com");
      assert.equal(calls[index].headers.get("accept-encoding"), "identity");
      assert.equal(calls[index].body.model, model);
    }
  });

  it("strips tokenrouter/ on the explicit route and restores the public model", async () => {
    const calls = mockJsonFetch(() => makeCompletion({ model: "internal-k3" }));
    const response = await invoke({
      model: "cursorproxy/tokenrouter/" + TOKENROUTER_KIMI_K3,
      messages: [{ role: "user", content: "ping" }],
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls[0].body.model, TOKENROUTER_KIMI_K3);
    assert.equal(body.model, "cursorproxy/tokenrouter/" + TOKENROUTER_KIMI_K3);
  });

  it("forwards -free catalog IDs unchanged", async () => {
    const calls = mockJsonFetch();
    const models = [
      "moonshotai/kimi-k3-free",
      "deepseek/deepseek-v4-pro-0813-free",
      "qwen/qwen3.8-max-free",
      "z-ai/glm-5.2-free",
      "z-ai/glm-5.3-free",
    ];
    for (const model of models) {
      const response = await invoke({
        model,
        messages: [{ role: "user", content: "ping" }],
      }, UNIFIED_PROXY_URL);
      const body = await response.json();
      assert.equal(response.status, 200, model);
      assert.equal(body.model, "cursorproxy/" + model);
    }
    assert.equal(calls.length, models.length);
    for (const [index, model] of models.entries()) {
      assert.equal(calls[index].body.model, model);
    }
  });

  it("normalizes UPSTREAM_TOKENROUTER with or without a trailing /v1", async () => {
    process.env.UPSTREAM_TOKENROUTER = "https://gateway.example.com";
    const withoutV1 = mockJsonFetch();
    await invoke({
      model: TOKENROUTER_KIMI_K3,
      messages: [{ role: "user", content: "ping" }],
    });
    assert.equal(withoutV1[0].url, "https://gateway.example.com/v1/chat/completions");

    process.env.UPSTREAM_TOKENROUTER = "https://gateway.example.com/v1/";
    const withV1 = mockJsonFetch();
    await invoke({
      model: TOKENROUTER_KIMI_K3,
      messages: [{ role: "user", content: "ping" }],
    });
    assert.equal(withV1[0].url, "https://gateway.example.com/v1/chat/completions");
  });

  it("rejects missing and unsupported TokenRouter models instead of defaulting", async () => {
    mockJsonFetch();
    const missing = await invoke({
      messages: [{ role: "user", content: "ping" }],
    });
    const missingBody = await missing.json();
    assert.equal(missing.status, 400);
    assert.equal(missingBody.error.code, "tokenrouter_model_unsupported");

    const unsupported = await invoke({
      model: "kimi-k3",
      messages: [{ role: "user", content: "ping" }],
    });
    const unsupportedBody = await unsupported.json();
    assert.equal(unsupported.status, 400);
    assert.equal(unsupportedBody.error.code, "tokenrouter_model_unsupported");

    const unknownStem = await invoke({
      model: "qwen/qwen3.7-max",
      messages: [{ role: "user", content: "ping" }],
    });
    const unknownStemBody = await unknownStem.json();
    assert.equal(unknownStem.status, 400);
    assert.equal(unknownStemBody.error.code, "tokenrouter_model_unsupported");

    const kimiK2 = await invoke({
      model: "moonshotai/kimi-k2.7-code",
      messages: [{ role: "user", content: "ping" }],
    });
    const kimiK2Body = await kimiK2.json();
    assert.equal(kimiK2.status, 400);
    assert.equal(kimiK2Body.error.code, "tokenrouter_model_unsupported");
  });

  it("returns 503 when TOKENROUTER_API_KEY is missing", async () => {
    delete process.env.TOKENROUTER_API_KEY;
    const response = await invoke({
      model: TOKENROUTER_KIMI_K3,
      messages: [{ role: "user", content: "ping" }],
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error.code, "provider_key_missing");
  });

  it("converts developer roles and sanitizes TokenRouter K3 bodies", async () => {
    const calls = mockJsonFetch();
    const namedToolChoice = {
      type: "function",
      function: { name: "record_description" },
    };
    const response = await invoke({
      model: TOKENROUTER_KIMI_K3,
      messages: [
        { role: "developer", content: "be concise" },
        { role: "user", content: "hi" },
      ],
      temperature: 0.4,
      top_p: 0.5,
      thinking: { type: "enabled", keep: "all" },
      reasoning_effort: "low",
      tool_choice: namedToolChoice,
      max_completion_tokens: 131072,
    }, UNIFIED_PROXY_URL);
    await response.text();

    assert.equal(response.status, 200);
    assert.equal(calls[0].body.messages[0].role, "system");
    assert.equal(calls[0].body.temperature, undefined);
    assert.equal(calls[0].body.thinking, undefined);
    assert.equal(calls[0].body.reasoning_effort, "max");
    assert.deepEqual(calls[0].body.tool_choice, namedToolChoice);
    assert.equal(calls[0].body.max_completion_tokens, 131072);
  });

  it("applies the K3 sanitizer to moonshotai/kimi-k3-free without rewriting the model", async () => {
    const calls = mockJsonFetch();
    const response = await invoke({
      model: "moonshotai/kimi-k3-free",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.4,
      thinking: { type: "enabled" },
      reasoning_effort: "low",
    }, UNIFIED_PROXY_URL);
    await response.text();
    assert.equal(response.status, 200);
    assert.equal(calls[0].body.model, "moonshotai/kimi-k3-free");
    assert.equal(calls[0].body.temperature, undefined);
    assert.equal(calls[0].body.thinking, undefined);
    assert.equal(calls[0].body.reasoning_effort, "max");
  });

  it("does not inject native DeepSeek thinking into TokenRouter DeepSeek requests", async () => {
    const calls = mockJsonFetch();
    await invoke({
      model: TOKENROUTER_DEEPSEEK_V4_FLASH,
      messages: [{ role: "user", content: "hi" }],
    }, UNIFIED_PROXY_URL);
    assert.equal(calls[0].body.thinking, undefined);
    assert.equal(calls[0].body.reasoning_effort, undefined);
  });

  it("sanitizes TokenRouter Qwen bodies without K3 sampling strip or DashScope extras", async () => {
    const calls = mockJsonFetch();
    const response = await invoke({
      model: "cursorproxy/tokenrouter/" + TOKENROUTER_QWEN_38_MAX,
      messages: [
        { role: "developer", content: "be concise" },
        { role: "user", content: "hi" },
      ],
      temperature: 0.4,
      thinking: { type: "enabled", keep: "all" },
      reasoning_effort: "max",
    }, UNIFIED_PROXY_URL);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls[0].body.model, TOKENROUTER_QWEN_38_MAX);
    assert.equal(body.model, "cursorproxy/tokenrouter/" + TOKENROUTER_QWEN_38_MAX);
    assert.equal(calls[0].body.messages[0].role, "system");
    assert.equal(calls[0].body.temperature, 0.4);
    assert.equal(calls[0].body.thinking, undefined);
    assert.equal(calls[0].body.reasoning_effort, "xhigh");
    assert.equal(calls[0].body.enable_thinking, undefined);
    assert.equal(calls[0].body.preserve_thinking, undefined);
  });

  it("rejects bare qwen3.8-max on the TokenRouter route", async () => {
    mockJsonFetch();
    const response = await invoke({
      model: "qwen3.8-max",
      messages: [{ role: "user", content: "ping" }],
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "tokenrouter_model_unsupported");
  });

  it("keeps K3 images native and bridges TokenRouter DeepSeek images", async () => {
    const imageContent = [
      { type: "text", text: "Describe this image." },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,a2ltaS1rMw==" },
      },
    ];
    const calls = mockJsonFetch();
    const k3 = await invoke({
      model: TOKENROUTER_KIMI_K3,
      messages: [{ role: "user", content: imageContent }],
    }, UNIFIED_PROXY_URL);
    await k3.text();
    assert.deepEqual(calls[0].body.messages[0].content, imageContent);

    const deepseek = await invoke({
      model: TOKENROUTER_DEEPSEEK_V4_PRO,
      messages: [{ role: "user", content: imageContent }],
    }, UNIFIED_PROXY_URL);
    await deepseek.text();
    const deepseekCall = calls.find((call) => call.body?.model === TOKENROUTER_DEEPSEEK_V4_PRO);
    assert.ok(deepseekCall);
    assert.equal(typeof deepseekCall.body.messages[0].content, "string");
    assert.match(deepseekCall.body.messages[0].content, /Image content: a screenshot of a terminal/);

    const qwen = await invoke({
      model: TOKENROUTER_QWEN_38_MAX,
      messages: [{ role: "user", content: imageContent }],
    }, UNIFIED_PROXY_URL);
    await qwen.text();
    const qwenCall = calls.find((call) => call.body?.model === TOKENROUTER_QWEN_38_MAX);
    assert.ok(qwenCall);
    assert.deepEqual(qwenCall.body.messages[0].content, imageContent);

    const glm = await invoke({
      model: TOKENROUTER_GLM_52,
      messages: [{ role: "user", content: imageContent }],
    }, UNIFIED_PROXY_URL);
    await glm.text();
    const glmCall = calls.find((call) => call.body?.model === TOKENROUTER_GLM_52);
    assert.ok(glmCall);
    assert.equal(typeof glmCall.body.messages[0].content, "string");
    assert.match(glmCall.body.messages[0].content, /Image content: a screenshot of a terminal/);

    const glm53 = await invoke({
      model: TOKENROUTER_GLM_53,
      messages: [{ role: "user", content: imageContent }],
    }, UNIFIED_PROXY_URL);
    await glm53.text();
    const glm53Call = calls.find((call) => call.body?.model === TOKENROUTER_GLM_53);
    assert.ok(glm53Call);
    assert.equal(typeof glm53Call.body.messages[0].content, "string");
    assert.match(glm53Call.body.messages[0].content, /Image content: a screenshot of a terminal/);
  });

  it("restores K3 reasoning from a model-qualified TokenRouter scope", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const calls = mockJsonFetch((_capturedCall, callIndex) => {
      if (callIndex === 0) {
        return makeCompletion({ content: "4", reasoningContent: "Add two and two." });
      }
      return makeCompletion({ content: "because 2+2=4" });
    });
    const firstTurn = [{ role: "user", content: "What is 2 + 2?" }];
    const first = await invoke({
      model: TOKENROUTER_KIMI_K3,
      messages: firstTurn,
    }, UNIFIED_PROXY_URL);
    const firstBody = await first.json();
    assert.equal(firstBody.choices[0].message.reasoning_content, undefined);

    const second = await invoke({
      model: TOKENROUTER_KIMI_K3,
      messages: [
        ...firstTurn,
        { role: "assistant", content: "4" },
        { role: "user", content: "Why?" },
      ],
    }, UNIFIED_PROXY_URL);
    await second.text();
    assert.equal(calls[1].body.messages[1].reasoning_content, "Add two and two.");

    const expectedCacheKey = await conversationHash(
      firstTurn,
      firstTurn.length,
      "tokenrouter:" + TOKENROUTER_KIMI_K3 + ":anon",
    );
    assert.equal(kvDriver.store.get(expectedCacheKey), "Add two and two.");
  });

  it("restores Qwen reasoning from a model-qualified TokenRouter scope", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const calls = mockJsonFetch((_capturedCall, callIndex) => {
      if (callIndex === 0) {
        return makeCompletion({
          model: TOKENROUTER_QWEN_38_MAX,
          content: "4",
          reasoningContent: "Add two and two.",
        });
      }
      return makeCompletion({
        model: TOKENROUTER_QWEN_38_MAX,
        content: "because 2+2=4",
      });
    });
    const firstTurn = [{ role: "user", content: "What is 2 + 2?" }];
    const first = await invoke({
      model: TOKENROUTER_QWEN_38_MAX,
      messages: firstTurn,
    }, UNIFIED_PROXY_URL);
    const firstBody = await first.json();
    assert.equal(firstBody.choices[0].message.reasoning_content, undefined);

    const second = await invoke({
      model: TOKENROUTER_QWEN_38_MAX,
      messages: [
        ...firstTurn,
        { role: "assistant", content: "4" },
        { role: "user", content: "Why?" },
      ],
    }, UNIFIED_PROXY_URL);
    await second.text();
    assert.equal(calls[1].body.messages[1].reasoning_content, "Add two and two.");

    const expectedCacheKey = await conversationHash(
      firstTurn,
      firstTurn.length,
      "tokenrouter:" + TOKENROUTER_QWEN_38_MAX + ":anon",
    );
    assert.equal(kvDriver.store.get(expectedCacheKey), "Add two and two.");
  });

  it("restores Qwen -free reasoning from the suffixed TokenRouter scope", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const freeId = "qwen/qwen3.8-max-free";
    const calls = mockJsonFetch((_capturedCall, callIndex) => {
      if (callIndex === 0) {
        return makeCompletion({
          model: freeId,
          content: "4",
          reasoningContent: "Add two and two.",
        });
      }
      return makeCompletion({
        model: freeId,
        content: "because 2+2=4",
      });
    });
    const firstTurn = [{ role: "user", content: "What is 2 + 2?" }];
    await (await invoke({
      model: freeId,
      messages: firstTurn,
    }, UNIFIED_PROXY_URL)).json();

    const second = await invoke({
      model: freeId,
      messages: [
        ...firstTurn,
        { role: "assistant", content: "4" },
        { role: "user", content: "Why?" },
      ],
    }, UNIFIED_PROXY_URL);
    await second.text();
    assert.equal(calls[1].body.model, freeId);
    assert.equal(calls[1].body.messages[1].reasoning_content, "Add two and two.");

    const suffixedKey = await conversationHash(
      firstTurn,
      firstTurn.length,
      "tokenrouter:" + freeId + ":anon",
    );
    const stemKey = await conversationHash(
      firstTurn,
      firstTurn.length,
      "tokenrouter:" + TOKENROUTER_QWEN_38_MAX + ":anon",
    );
    assert.equal(kvDriver.store.get(suffixedKey), "Add two and two.");
    assert.equal(kvDriver.store.get(stemKey), undefined);
  });

  it("forwards mixed-case Qwen IDs unchanged and scopes KV to that client ID", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const mixedId = "Qwen/Qwen3.8-Max";
    const calls = mockJsonFetch((_capturedCall, callIndex) => {
      if (callIndex === 0) {
        return makeCompletion({
          model: mixedId,
          content: "4",
          reasoningContent: "Add two and two.",
        });
      }
      return makeCompletion({
        model: mixedId,
        content: "because 2+2=4",
      });
    });
    const firstTurn = [{ role: "user", content: "What is 2 + 2?" }];
    const first = await invoke({
      model: mixedId,
      messages: firstTurn,
    }, UNIFIED_PROXY_URL);
    await first.json();
    assert.equal(calls[0].body.model, mixedId);

    const second = await invoke({
      model: mixedId,
      messages: [
        ...firstTurn,
        { role: "assistant", content: "4" },
        { role: "user", content: "Why?" },
      ],
    }, UNIFIED_PROXY_URL);
    await second.text();
    assert.equal(calls[1].body.model, mixedId);
    assert.equal(calls[1].body.messages[1].reasoning_content, "Add two and two.");

    const expectedCacheKey = await conversationHash(
      firstTurn,
      firstTurn.length,
      "tokenrouter:" + mixedId + ":anon",
    );
    assert.equal(kvDriver.store.get(expectedCacheKey), "Add two and two.");
  });

  it("skips Qwen reasoning restore when thinking.type is disabled", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const firstTurn = [{ role: "user", content: "What is 2 + 2?" }];
    mockJsonFetch(() => makeCompletion({
      model: TOKENROUTER_QWEN_38_MAX,
      content: "4",
      reasoningContent: "Add two and two.",
    }));
    await (await invoke({
      model: TOKENROUTER_QWEN_38_MAX,
      messages: firstTurn,
    }, UNIFIED_PROXY_URL)).json();

    const calls = mockJsonFetch();
    await invoke({
      model: TOKENROUTER_QWEN_38_MAX,
      messages: [
        ...firstTurn,
        { role: "assistant", content: "4" },
        { role: "user", content: "Why?" },
      ],
      thinking: { type: "disabled" },
    }, UNIFIED_PROXY_URL);
    assert.equal(calls[0].body.messages[1].reasoning_content, undefined);
    assert.equal(calls[0].body.thinking, undefined);
  });

  it("skips Qwen reasoning restore when reasoning_effort is None", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const firstTurn = [{ role: "user", content: "What is 2 + 2?" }];
    mockJsonFetch(() => makeCompletion({
      model: TOKENROUTER_QWEN_38_MAX,
      content: "4",
      reasoningContent: "Add two and two.",
    }));
    await (await invoke({
      model: TOKENROUTER_QWEN_38_MAX,
      messages: firstTurn,
    }, UNIFIED_PROXY_URL)).json();

    const calls = mockJsonFetch();
    await invoke({
      model: TOKENROUTER_QWEN_38_MAX,
      messages: [
        ...firstTurn,
        { role: "assistant", content: "4" },
        { role: "user", content: "Why?" },
      ],
      reasoning_effort: "None",
    }, UNIFIED_PROXY_URL);
    assert.equal(calls[0].body.messages[1].reasoning_content, undefined);
    assert.equal(calls[0].body.reasoning_effort, undefined);
  });

  it("restores GLM 5.2 reasoning from a model-qualified TokenRouter scope isolated from native GLM", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const calls = mockJsonFetch((_capturedCall, callIndex) => {
      if (callIndex === 0) {
        return makeCompletion({
          model: TOKENROUTER_GLM_52,
          content: "4",
          reasoningContent: "Add two and two.",
        });
      }
      return makeCompletion({
        model: TOKENROUTER_GLM_52,
        content: "because 2+2=4",
      });
    });
    const firstTurn = [{ role: "user", content: "What is 2 + 2?" }];
    const first = await invoke({
      model: TOKENROUTER_GLM_52,
      messages: firstTurn,
    }, UNIFIED_PROXY_URL);
    const firstBody = await first.json();
    assert.equal(firstBody.choices[0].message.reasoning_content, undefined);

    const second = await invoke({
      model: TOKENROUTER_GLM_52,
      messages: [
        ...firstTurn,
        { role: "assistant", content: "4" },
        { role: "user", content: "Why?" },
      ],
    }, UNIFIED_PROXY_URL);
    await second.text();
    assert.equal(calls[1].body.model, TOKENROUTER_GLM_52);
    assert.equal(calls[1].body.messages[1].reasoning_content, "Add two and two.");

    const expectedCacheKey = await conversationHash(
      firstTurn,
      firstTurn.length,
      "tokenrouter:" + TOKENROUTER_GLM_52 + ":anon",
    );
    assert.equal(kvDriver.store.get(expectedCacheKey), "Add two and two.");

    const nativeGlmKey = await conversationHash(
      firstTurn,
      firstTurn.length,
      "glm:anon",
    );
    assert.equal(kvDriver.store.get(nativeGlmKey), undefined);
  });

  it("sanitizes TokenRouter GLM 5.2 bodies without GLM-native injection or max_tokens remap", async () => {
    const calls = mockJsonFetch();
    const response = await invoke({
      model: "cursorproxy/tokenrouter/" + TOKENROUTER_GLM_52,
      messages: [
        { role: "developer", content: "be concise" },
        { role: "user", content: "hi" },
      ],
      temperature: 0.4,
      thinking: { type: "enabled", keep: "all" },
      reasoning_effort: "high",
      max_completion_tokens: 4096,
    }, UNIFIED_PROXY_URL);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls[0].body.model, TOKENROUTER_GLM_52);
    assert.equal(body.model, "cursorproxy/tokenrouter/" + TOKENROUTER_GLM_52);
    assert.equal(calls[0].body.messages[0].role, "system");
    assert.equal(calls[0].body.temperature, 0.4);
    assert.equal(calls[0].body.thinking, undefined);
    assert.equal(calls[0].body.reasoning_effort, "high");
    assert.equal(calls[0].body.max_completion_tokens, 4096);
    assert.equal(calls[0].body.max_tokens, undefined);
    assert.equal(calls[0].body.tool_stream, undefined);
    assert.equal(calls[0].body.enable_thinking, undefined);
  });

  it("sanitizes TokenRouter GLM 5.3 bodies and forwards the client ID", async () => {
    const calls = mockJsonFetch();
    const response = await invoke({
      model: TOKENROUTER_GLM_53,
      messages: [
        { role: "developer", content: "be concise" },
        { role: "user", content: "hi" },
      ],
      temperature: 0.4,
      thinking: { type: "enabled" },
      reasoning_effort: "medium",
      tool_stream: true,
      max_completion_tokens: 4096,
    }, UNIFIED_PROXY_URL);
    await response.text();
    assert.equal(response.status, 200);
    assert.equal(calls[0].body.model, TOKENROUTER_GLM_53);
    assert.equal(calls[0].body.messages[0].role, "system");
    assert.equal(calls[0].body.thinking, undefined);
    assert.equal(calls[0].body.tool_stream, undefined);
    assert.equal(calls[0].body.reasoning_effort, "medium");
    assert.equal(calls[0].body.max_completion_tokens, 4096);
    assert.equal(calls[0].body.max_tokens, undefined);
  });

  it("passes through an upstream 400 for z-ai/glm-5.3", async () => {
    const calls = [];
    global.fetch = async (_url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push(body);
      return new Response(JSON.stringify({
        error: {
          message: "model z-ai/glm-5.3 is not available",
          type: "invalid_request_error",
          code: "model_not_found",
        },
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };

    const response = await invoke({
      model: TOKENROUTER_GLM_53,
      messages: [{ role: "user", content: "ping" }],
    }, UNIFIED_PROXY_URL);
    const body = await response.json();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, TOKENROUTER_GLM_53);
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "model_not_found");
    assert.match(body.error.message, /z-ai\/glm-5\.3 is not available/);
    assert.notEqual(body.error.code, "tokenrouter_model_unsupported");
  });

  it("skips GLM 5.2 reasoning restore when thinking.type is disabled", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const firstTurn = [{ role: "user", content: "What is 2 + 2?" }];
    mockJsonFetch(() => makeCompletion({
      model: TOKENROUTER_GLM_52,
      content: "4",
      reasoningContent: "Add two and two.",
    }));
    await (await invoke({
      model: TOKENROUTER_GLM_52,
      messages: firstTurn,
    }, UNIFIED_PROXY_URL)).json();

    const calls = mockJsonFetch();
    await invoke({
      model: TOKENROUTER_GLM_52,
      messages: [
        ...firstTurn,
        { role: "assistant", content: "4" },
        { role: "user", content: "Why?" },
      ],
      thinking: { type: "disabled" },
    }, UNIFIED_PROXY_URL);
    assert.equal(calls[0].body.messages[1].reasoning_content, undefined);
    assert.equal(calls[0].body.thinking, undefined);
  });

  it("forwards reasoning_effort none on GLM 5.2 and skips restore", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const firstTurn = [{ role: "user", content: "What is 2 + 2?" }];
    mockJsonFetch(() => makeCompletion({
      model: TOKENROUTER_GLM_52,
      content: "4",
      reasoningContent: "Add two and two.",
    }));
    await (await invoke({
      model: TOKENROUTER_GLM_52,
      messages: firstTurn,
    }, UNIFIED_PROXY_URL)).json();

    const calls = mockJsonFetch();
    await invoke({
      model: TOKENROUTER_GLM_52,
      messages: [
        ...firstTurn,
        { role: "assistant", content: "4" },
        { role: "user", content: "Why?" },
      ],
      reasoning_effort: "none",
    }, UNIFIED_PROXY_URL);
    assert.equal(calls[0].body.messages[1].reasoning_content, undefined);
    assert.equal(calls[0].body.reasoning_effort, "none");
  });

  it("replays TokenRouter DeepSeek reasoning across user turns when tools are present", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const tools = [{
      type: "function",
      function: { name: "lookup", parameters: { type: "object", properties: {} } },
    }];
    const firstTurn = [{ role: "user", content: "Look this up." }];
    mockJsonFetch(() => makeCompletion({
      model: TOKENROUTER_DEEPSEEK_V4_PRO,
      content: "done",
      reasoningContent: "tool reasoning",
    }));
    await (await invoke({
      model: TOKENROUTER_DEEPSEEK_V4_PRO,
      messages: firstTurn,
      tools,
    }, UNIFIED_PROXY_URL)).json();

    const calls = mockJsonFetch();
    await invoke({
      model: TOKENROUTER_DEEPSEEK_V4_PRO,
      messages: [
        ...firstTurn,
        { role: "assistant", content: "done" },
        { role: "user", content: "And again." },
      ],
      tools,
    }, UNIFIED_PROXY_URL);
    assert.equal(calls[0].body.messages[1].reasoning_content, "tool reasoning");
  });

  it("skips TokenRouter DeepSeek reasoning injection on no-tools user-ending turns", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const firstTurn = [{ role: "user", content: "Hello." }];
    mockJsonFetch(() => makeCompletion({
      model: TOKENROUTER_DEEPSEEK_V4_FLASH,
      content: "hi",
      reasoningContent: "private flash reasoning",
    }));
    await (await invoke({
      model: TOKENROUTER_DEEPSEEK_V4_FLASH,
      messages: firstTurn,
    }, UNIFIED_PROXY_URL)).json();

    const calls = mockJsonFetch();
    await invoke({
      model: TOKENROUTER_DEEPSEEK_V4_FLASH,
      messages: [
        ...firstTurn,
        { role: "assistant", content: "hi" },
        { role: "user", content: "Continue." },
      ],
    }, UNIFIED_PROXY_URL);
    assert.equal(calls[0].body.messages[1].reasoning_content, undefined);
  });

  it("uses hit-only restoration and isolates reasoning across TokenRouter models", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const firstTurn = [{ role: "user", content: "Shared prompt." }];
    const continued = [
      ...firstTurn,
      { role: "assistant", content: "Prior answer." },
      { role: "user", content: "Continue." },
    ];
    const calls = mockJsonFetch();
    await invoke({
      model: TOKENROUTER_KIMI_K3,
      messages: continued,
    }, UNIFIED_PROXY_URL);
    assert.equal(calls[0].body.messages[1].reasoning_content, undefined);

    mockJsonFetch(() => makeCompletion({
      content: "k3",
      reasoningContent: "k3-only reasoning",
    }));
    await (await invoke({
      model: TOKENROUTER_KIMI_K3,
      messages: firstTurn,
    }, UNIFIED_PROXY_URL)).json();

    const later = mockJsonFetch();
    await invoke({
      model: TOKENROUTER_DEEPSEEK_V4_PRO,
      messages: continued,
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    }, UNIFIED_PROXY_URL);
    assert.equal(later[0].body.messages[1].reasoning_content, undefined);

    const qwenLater = mockJsonFetch();
    await invoke({
      model: TOKENROUTER_QWEN_38_MAX,
      messages: continued,
    }, UNIFIED_PROXY_URL);
    assert.equal(qwenLater[0].body.messages[1].reasoning_content, undefined);

    const glmLater = mockJsonFetch();
    await invoke({
      model: TOKENROUTER_GLM_52,
      messages: continued,
    }, UNIFIED_PROXY_URL);
    assert.equal(glmLater[0].body.messages[1].reasoning_content, undefined);
  });

  it("passes through a DeepSeek tools 400 when empty KV cannot restore reasoning", async () => {
    setKvDriver(makeInMemoryKv());
    const tools = [{
      type: "function",
      function: { name: "lookup", parameters: { type: "object", properties: {} } },
    }];
    const calls = [];
    global.fetch = async (_url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push(body);
      const assistantTurns = (body?.messages || []).filter((message) => message?.role === "assistant");
      const missingReasoning = assistantTurns.some((message) => !message.reasoning_content);
      if (missingReasoning) {
        return new Response(JSON.stringify({
          error: {
            message: "thinking is enabled but reasoning_content is missing in assistant",
            type: "invalid_request_error",
            code: "invalid_request_error",
          },
        }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(makeCompletion({
        model: TOKENROUTER_DEEPSEEK_V4_PRO,
        content: "ok",
      })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const response = await invoke({
      model: TOKENROUTER_DEEPSEEK_V4_PRO,
      messages: [
        { role: "user", content: "Look this up." },
        { role: "assistant", content: "done" },
        { role: "user", content: "And again." },
      ],
      tools,
    }, UNIFIED_PROXY_URL);
    const body = await response.json();
    assert.equal(calls[0].messages[1].reasoning_content, undefined);
    assert.equal(response.status, 400);
    assert.match(body.error.message, /reasoning_content is missing/);
  });

  it("strips streamed TokenRouter reasoning while caching it", async () => {
    const kvDriver = makeInMemoryKv();
    setKvDriver(kvDriver);
    const messages = [{ role: "user", content: "Stream an answer." }];
    const streamBody = [
      `data: ${JSON.stringify({
        id: "chatcmpl_tr_stream",
        object: "chat.completion.chunk",
        model: TOKENROUTER_KIMI_K3,
        choices: [{
          index: 0,
          delta: { role: "assistant", reasoning_content: "streamed TR reasoning" },
          finish_reason: null,
        }],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl_tr_stream",
        object: "chat.completion.chunk",
        model: TOKENROUTER_KIMI_K3,
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

    const response = await invoke({
      model: TOKENROUTER_KIMI_K3,
      messages,
      stream: true,
    }, UNIFIED_PROXY_URL);
    const clientStream = await response.text();
    assert.equal(response.status, 200);
    assert.match(clientStream, /Visible answer\./);
    assert.match(clientStream, /cursorproxy\/moonshotai\/kimi-k3/);
    assert.doesNotMatch(clientStream, /streamed TR reasoning|reasoning_content/);

    const expectedCacheKey = await conversationHash(
      messages,
      messages.length,
      "tokenrouter:" + TOKENROUTER_KIMI_K3 + ":anon",
    );
    assert.equal(kvDriver.store.get(expectedCacheKey), "streamed TR reasoning");
  });

  it("keeps native Kimi and DeepSeek routes unchanged", async () => {
    const kimiCalls = mockJsonFetch();
    const kimi = await invoke({
      model: "kimi-k3",
      messages: [{ role: "user", content: "ping" }],
    }, KIMI_PROVIDER_URL);
    await kimi.text();
    assert.equal(kimiCalls[0].url, "https://api.moonshot.ai/v1/chat/completions");
    assert.equal(kimiCalls[0].body.model, "kimi-k3");

    const deepseekCalls = mockJsonFetch();
    const deepseek = await invoke({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "ping" }],
    }, DEEPSEEK_PROVIDER_URL);
    await deepseek.text();
    assert.equal(deepseekCalls[0].url, "https://api.deepseek.com/v1/chat/completions");
    assert.equal(deepseekCalls[0].body.model, "deepseek-v4-flash");
    assert.deepEqual(deepseekCalls[0].body.thinking, { type: "enabled" });
  });

  it("lists TokenRouter catalog IDs from CURSORPROXY_MODELS", async () => {
    process.env.CURSORPROXY_MODELS = TOKENROUTER_KIMI_K3;
    const response = await handler(new Request(MODELS_URL, { method: "GET" }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data[0].id, "cursorproxy/" + TOKENROUTER_KIMI_K3);
  });
});
