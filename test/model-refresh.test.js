import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/proxy.js";
import { setKvDriver } from "../lib/kv.js";
import { conversationHash } from "../lib/cache.js";
import { configuredModelIds, providerFromModel, resolveCompatibleAlias } from "../lib/models.js";
import { requiresVisionBridge } from "../lib/vision-bridge.js";
import { deriveOpenAICompatResponsesHaloPromptCacheKey } from "../lib/openaicompat-cache.js";

const messages = [{ role: "user", content: "Use echo to check this value." }];
const tools = [{ type: "function", function: { name: "echo", description: "Echo a value", parameters: { type: "object", properties: { value: { type: "string" } } } } }];
const nativeTools = [{ name: "echo", description: "Echo a value", input_schema: { type: "object", properties: { value: { type: "string" } } } }];
const toolCall = { id: "call_echo", type: "function", function: { name: "echo", arguments: '{"value":"ok"}' } };
const imageMessages = [{ role: "user", content: [{ type: "text", text: "Describe this image" }, { type: "image_url", image_url: { url: "data:image/png;base64,dGVzdA==" } }] }];
const gptModels = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"];
const claudeModels = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"];
const envKeys = ["CURSORPROXY_API_KEY", "CURSORPROXY_MODELS", "DEBUG", "KV_RETRY_DELAYS_MS",
  "UPSTREAM_GLM", "GLM_NATIVE_FIELDS", "GLM_REASONING_EFFORT", "DEEPSEEK_REASONING_EFFORT",
  "AZURE_FOUNDRY_API_KEY", "AZURE_FOUNDRY_RESOURCE", "AZURE_ANTHROPIC_ENDPOINT", "AZURE_OPENAI_ENDPOINT",
  "AZURE_ANTHROPIC_THINKING", "AZURE_ANTHROPIC_EFFORT", "AZURE_OPENAI_REASONING_EFFORT",
  "AZURE_OPENAI_GENERAL_ALIAS_TARGET", "AZURE_OPENAI_GENERAL_REASONING_EFFORT",
  "OPENAICOMPAT_DEFAULT_MODEL", "OPENAICOMPAT_WIRE_API", "OPENAICOMPAT_CACHE_HIT_MODE",
  "OPENAICOMPAT_CHAT_CACHE_MODE", "OPENAICOMPAT_REASONING_EFFORT", "OPENAICOMPAT_REASONING_CACHE", "UPSTREAM_OPENAICOMPAT",
  "ANTHROPICCOMPAT_DEFAULT_MODEL", "ANTHROPICCOMPAT_THINKING_CACHE", "UPSTREAM_ANTHROPICCOMPAT",
  "FIREWORKS_GLM_REASONING_EFFORT", "VISION_API_PROVIDER", "VISION_MODEL", "VISION_API_URL", "VISION_API_KEY",
  ...["DEEPSEEK", "MIMO", "MINIMAX", "KIMI", "GLM", "FIREWORKS", "TOKENROUTER", "OPENAICOMPAT", "ANTHROPICCOMPAT"].map((p) => `${p}_API_KEY`)];

function completion(body, extra = {}) {
  return { id: "chat_refresh", model: body.model, object: "chat.completion", choices: [{ index: 0,
    message: { role: "assistant", content: "ok", ...extra }, finish_reason: extra.tool_calls ? "tool_calls" : "stop" }] };
}
function anthropic(body, blocks = [{ type: "text", text: "ok" }]) {
  return { id: "msg_refresh", type: "message", role: "assistant", model: body.model, content: blocks, stop_reason: "end_turn" };
}
function sse(events) {
  return new Response(events.map((data) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}
async function invoke(body, provider = "", path = "chat/completions") {
  return handler(new Request(`https://proxy.test/api/proxy?path=${path}${provider ? `&provider=${provider}` : ""}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}

describe("October model refresh through the shared handler", () => {
  let savedEnv, savedFetch, kv, calls, responder;
  beforeEach(() => {
    savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    for (const key of envKeys.filter((k) => k.endsWith("_API_KEY") && k !== "CURSORPROXY_API_KEY")) process.env[key] = "fixture-key";
    process.env.KV_RETRY_DELAYS_MS = "0";
    process.env.AZURE_FOUNDRY_RESOURCE = "fixture";
    process.env.UPSTREAM_OPENAICOMPAT = "https://api.openai.com";
    process.env.UPSTREAM_ANTHROPICCOMPAT = "https://api.anthropic.com";
    kv = new Map();
    setKvDriver({ get: async (key) => kv.get(key) ?? null, set: async (key, value) => kv.set(key, value), del: async (key) => kv.delete(key) });
    calls = [];
    responder = (body, url) => url.includes("/messages") ? anthropic(body) : completion(body);
    savedFetch = global.fetch;
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body, headers: new Headers(init.headers) });
      if (String(url).includes("coding_plan/vlm")) return Response.json({ content: "fixture image description" });
      const result = responder(body, String(url));
      return result instanceof Response ? result : Response.json(result);
    };
  });
  afterEach(() => {
    global.fetch = savedFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    setKvDriver(null);
  });

  for (const [provider, model] of Object.entries({ deepseek: "deepseek-flash", mimo: "mimo-v2.6-pro", glm: "glm-5.3", kimi: "kimi-k3", minimax: "MiniMax-M3", azureanthropic: "claude-sonnet-5-5" })) {
    it(`defaults ${provider} before sanitization`, async () => {
      const res = await invoke({ messages, temperature: 0.4 }, provider);
      assert.equal(res.status, 200);
      assert.equal(calls.at(-1).body.model, model);
      if (provider === "azureanthropic") assert.equal(calls.at(-1).body.temperature, undefined);
      if (provider === "glm") assert.equal(calls.at(-1).body.reasoning_effort, "max");
    });
  }
  for (const [model, provider] of [...gptModels.map((m) => [m, "openaicompat"]), ...claudeModels.map((m) => [m, "anthropiccompat"])]) {
    it(`routes ${model} alias, public alias, and explicit bare route without retargeting`, async () => {
      for (const id of [`compatible-${model}`, `cursorproxy/compatible-${model}`, model]) {
        const response = await invoke({ model: id, messages }, id === model ? provider : "");
        assert.equal(response.status, 200);
        assert.equal(calls.at(-1).body.model, model);
        assert.equal((await response.json()).model, `cursorproxy/${id.replace(/^cursorproxy\//, "")}`);
      }
      assert.equal(providerFromModel(model), model.startsWith("claude") ? "azureanthropic" : "azureopenai");
    });
  }
  it("preserves configured legacy discovery IDs and legacy alias targets", async () => {
    process.env.CURSORPROXY_MODELS = "deepseek-chat,mimo-v2.5-pro,compatible-gpt-5.6,compatible-gpt-6.1-sol,deepseek-chat";
    assert.deepEqual(configuredModelIds(), ["deepseek-chat", "mimo-v2.5-pro", "compatible-gpt-5.6", "compatible-gpt-6.1-sol"].map((m) => `cursorproxy/${m}`));
    assert.equal(resolveCompatibleAlias("compatible-gpt-5.6").upstream, "gpt-5.6-sol");
    assert.equal(resolveCompatibleAlias("compatible-gpt-5.5").upstream, "gpt-5.5");
    for (const provider of ["openaicompat", "anthropiccompat"]) {
      await invoke({ messages }, provider);
      assert.equal(calls.at(-1).body.model, undefined);
    }
  });

  it("keeps native images and bridges only documented text-only models", async () => {
    for (const model of ["deepseek-flash", "deepseek-v4-flash", "mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed", "glm-5.3-flash", "MiniMax-M3.1-Flash-Preview"]) {
      const start = calls.length;
      assert.equal((await invoke({ model, messages: imageMessages })).status, 200);
      assert.equal(calls.length - start, 1, model);
      assert.deepEqual(calls.at(-1).body.messages, imageMessages, model);
    }
    for (const model of ["deepseek-v4-pro", "mimo-v2.5-pro", "glm-5.3", "fireworks/glm-5p3"]) {
      assert.equal((await invoke({ model, messages: imageMessages })).status, 200);
      assert.doesNotMatch(JSON.stringify(calls.at(-1).body.messages), /image_url/);
      assert.match(JSON.stringify(calls.at(-1).body.messages), /fixture image description/);
    }
    assert.equal(requiresVisionBridge("deepseek", "deepseek-v4-flash", "https://gateway.test"), true);
    assert.equal(requiresVisionBridge("deepseek", "deepseek-v4-flash-vision-exp", "https://api.deepseek.com/v1/chat/completions"), false);
  });

  it("keeps default, bare and public MiMo Pro images native while bridging legacy Pro", async () => {
    // Native images must work without credentials for the separate vision backend.
    delete process.env.MINIMAX_API_KEY;
    for (const [model, provider] of [[undefined, "mimo"], ["mimo-v2.6-pro", "mimo"], ["mimo-v2.6-pro", ""], ["cursorproxy/mimo-v2.6-pro", ""]]) {
      const start = calls.length;
      const response = await invoke({ model, messages: imageMessages }, provider);
      assert.equal(response.status, 200);
      assert.equal(calls.length - start, 1);
      assert.match(calls.at(-1).url, /\/chat\/completions$/);
      assert.equal(calls.at(-1).body.model, "mimo-v2.6-pro");
      assert.deepEqual(calls.at(-1).body.messages, imageMessages);
    }
    process.env.MINIMAX_API_KEY = "fixture-key";
    const start = calls.length;
    assert.equal((await invoke({ model: "mimo-v2.5-pro", messages: imageMessages })).status, 200);
    assert.equal(calls.length - start, 2);
    assert.match(calls[start].url, /coding_plan\/vlm/);
    assert.match(calls[start + 1].url, /\/chat\/completions$/);
    assert.doesNotMatch(JSON.stringify(calls.at(-1).body.messages), /image_url/);
    assert.match(JSON.stringify(calls.at(-1).body.messages), /fixture image description/);
  });

  it("keeps DeepSeek low effort and full historical reasoning across tool turns", async () => {
    process.env.DEEPSEEK_REASONING_EFFORT = "low";
    responder = (body) => completion(body, { reasoning_content: "full prior trace", tool_calls: [toolCall] });
    const first = await (await invoke({ model: "deepseek-flash", messages, tools })).json();
    assert.equal(first.choices[0].message.reasoning_content, undefined);
    const next = [...messages, first.choices[0].message, { role: "tool", tool_call_id: "call_echo", content: "ok" }, { role: "user", content: "Check again" }];
    await invoke({ model: "deepseek-flash", messages: next, tools });
    assert.equal(calls.at(-1).body.reasoning_effort, "low");
    assert.equal(calls.at(-1).body.messages[1].reasoning_content, "full prior trace");
  });

  for (const host of ["open.bigmodel.cn", "api.z.ai"]) {
    for (const codingPlan of [true, false]) {
      const endpoint = codingPlan ? "Coding Plan" : "standard API";
      for (const model of ["glm-5.3", "glm-5.3-flash", ...(!codingPlan ? ["glm-5.3-flashx"] : [])]) {
        it(`validates ${model} effort for ${host} ${endpoint}`, async () => {
          process.env.UPSTREAM_GLM = `https://${host}/api/${codingPlan ? "coding/" : ""}paas/v4`;
          assert.equal((await invoke({ model, messages })).status, 200);
          assert.equal(calls.length, 1);
          assert.equal(calls[0].body.reasoning_effort, "max");
          for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
            const accepted = effort !== "ultra" && (codingPlan || ["low", "high", "max"].includes(effort));
            const start = calls.length;
            const response = await invoke({ model, messages, reasoning_effort: effort });
            assert.equal(response.status, accepted ? 200 : 400, effort);
            assert.equal(calls.length - start, accepted ? 1 : 0, effort);
            if (accepted) {
              assert.equal(calls.at(-1).url, `${process.env.UPSTREAM_GLM}/chat/completions`);
              assert.equal(calls.at(-1).body.reasoning_effort, effort);
              assert.equal(calls.at(-1).body.thinking.type, "enabled");
            } else {
              const error = (await response.json()).error;
              assert.equal(error.code, "glm_parameter_invalid");
              assert.ok(error.message.includes(endpoint));
            }
          }
          for (const [env, client, accepted, effort] of [
            ['  "medium"  ', "low", codingPlan, "medium"],
            ["  'low'  ", "ultra", true, "low"],
            ["ultra", "low", false],
            ["  ", "high", true, "high"],
          ]) {
            process.env.GLM_REASONING_EFFORT = env;
            const start = calls.length;
            const response = await invoke({ model, messages, reasoning_effort: client });
            assert.equal(response.status, accepted ? 200 : 400, env);
            assert.equal(calls.length - start, accepted ? 1 : 0, env);
            if (accepted) assert.equal(calls.at(-1).body.reasoning_effort, effort);
          }
          delete process.env.GLM_REASONING_EFFORT;
          const start = calls.length;
          assert.equal((await invoke({ model, messages, thinking: { type: "disabled" } })).status, 400);
          assert.equal(calls.length, start);
        });
      }
    }
  }
  it("preserves default Coding Plan effort forwarding and legacy/gateway behavior", async () => {
    assert.equal((await invoke({ messages, reasoning_effort: "medium" }, "glm")).status, 200);
    assert.equal(calls.at(-1).body.model, "glm-5.3");
    assert.equal(calls.at(-1).body.reasoning_effort, "medium");
    assert.equal(calls.at(-1).url, "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions");
    for (const host of ["open.bigmodel.cn", "api.z.ai"]) {
      for (const path of ["/api/coding/paas/v4", "/api/paas/v4"]) {
        process.env.UPSTREAM_GLM = `https://${host}${path}`;
        assert.equal((await invoke({ model: "glm-5.2", messages, reasoning_effort: "medium" })).status, 200);
        assert.equal(calls.at(-1).body.reasoning_effort, "medium");
      }
    }
    for (const path of ["/v1", "/api/coding/paas/v4"]) {
      process.env.UPSTREAM_GLM = `https://gateway.test${path}`;
      assert.equal((await invoke({ model: "glm-5.3", messages, thinking: { type: "disabled" }, reasoning_effort: "medium" })).status, 200);
      assert.equal(calls.at(-1).body.reasoning_effort, "medium");
      assert.equal(calls.at(-1).body.thinking, undefined);
    }
    process.env.GLM_NATIVE_FIELDS = "true";
    await invoke({ model: "glm-5.3", messages });
    assert.equal(calls.at(-1).body.thinking.type, "enabled");
  });
  it("rejects FlashX on Coding Plan and honors disabled native fields even on a cache miss", async () => {
    for (const host of ["open.bigmodel.cn", "api.z.ai"]) {
      process.env.UPSTREAM_GLM = `https://${host}/api/coding/paas/v4`;
      assert.equal((await invoke({ model: "glm-5.3-flashx", messages })).status, 400);
      assert.equal(calls.length, 0);
    }
    process.env.UPSTREAM_GLM = "https://api.z.ai/api/paas/v4";
    await invoke({ model: "glm-5.3-flashx", messages: imageMessages });
    assert.deepEqual(calls.at(-1).body.messages, imageMessages);
    process.env.GLM_NATIVE_FIELDS = "false";
    await invoke({ model: "glm-5.3", messages: [...messages, { role: "assistant", content: "old answer" }, { role: "user", content: "Continue" }] });
    assert.equal(calls.at(-1).body.thinking, undefined);
  });
  it("applies K2.7 Code rules to Highspeed without changing K3", async () => {
    await invoke({ model: "kimi-k2.7-code-highspeed", messages, thinking: { type: "enabled" }, reasoning_effort: "low", temperature: 0.5, top_p: 0.9, tools, tool_choice: "required", max_completion_tokens: 128 });
    const body = calls.at(-1).body;
    for (const key of ["thinking", "reasoning_effort", "temperature", "top_p", "max_completion_tokens"]) assert.equal(body[key], undefined);
    assert.equal(body.tool_choice, "auto");
    assert.equal(body.max_tokens, 16000);
    await invoke({ model: "kimi-k3", messages, tools, tool_choice: "required", reasoning_effort: "low" });
    assert.equal(calls.at(-1).body.tool_choice, "required");
    assert.equal(calls.at(-1).body.reasoning_effort, "max");
  });
  it("forwards canonical Fireworks IDs and hosted effort without native sanitizers", async () => {
    process.env.FIREWORKS_GLM_REASONING_EFFORT = "low";
    for (const model of ["deepseek-v4p1-flash", "kimi-k3", "glm-5p3", "glm-5p3-flash", "minimax-m3"]) {
      for (const id of [`fireworks/${model}`, `cursorproxy/fireworks/${model}`, `accounts/fireworks/models/${model}`, model]) {
        await invoke({ model: id, messages, reasoning_effort: "medium", tools, tool_choice: "required" }, id === model ? "fireworks" : "");
        assert.equal(calls.at(-1).body.model, `accounts/fireworks/models/${model}`);
        assert.equal(calls.at(-1).body.reasoning_effort, "medium");
        assert.equal(calls.at(-1).body.tool_choice, "required");
        assert.equal(calls.at(-1).body.thinking, undefined);
      }
    }
  });

  for (const format of ["content-json", "content-stream", "details-json", "details-stream"]) {
    it(`round-trips MiniMax ${format} without exposing reasoning`, async () => {
      const isContent = format.startsWith("content");
      const field = isContent ? "reasoning_content" : "reasoning_details";
      const value = isContent ? "first second" : [{ type: "text", text: "first second" }];
      const model = "MiniMax-M3.1-Flash-Preview";
      if (format.endsWith("stream")) {
        responder = () => sse([
          { choices: [{ index: 0, delta: { [field]: isContent ? "first " : [{ type: "text", text: "first " }] } }] },
          { choices: [{ index: 0, delta: { [field]: isContent ? "second" : value } }] },
          { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]",
        ]);
      } else responder = (body) => completion(body, { [field]: value });
      const response = await invoke({ model, messages, stream: format.endsWith("stream") });
      const output = await response.text();
      assert.equal(response.status, 200);
      assert.doesNotMatch(output, /first|second|reasoning_content|reasoning_details|__cursorproxy/);
      assert.match(output, /ok/);
      responder = (body) => completion(body);
      await invoke({ model, messages: [...messages, { role: "assistant", content: "ok" }, { role: "user", content: "Continue" }] });
      assert.deepEqual(calls.at(-1).body.messages[1][field], value);
      assert.equal(calls.at(-1).body.messages[1][isContent ? "reasoning_details" : "reasoning_content"], undefined);
    });
  }
  it("reads legacy MiniMax caches while isolating the M3.1 preview", async () => {
    const old = [{ type: "text", text: "legacy trace" }];
    kv.set(await conversationHash(messages, 1, "minimax:anon"), JSON.stringify(old));
    const next = [...messages, { role: "assistant", content: "ok" }, { role: "tool", tool_call_id: "call_echo", content: "ok" }];
    await invoke({ model: "MiniMax-M2.7", messages: next });
    assert.deepEqual(calls.at(-1).body.messages[1].reasoning_details, old);
    await invoke({ model: "MiniMax-M3.1-Flash-Preview", messages: next });
    assert.equal(calls.at(-1).body.messages[1].reasoning_details, undefined);
    assert.doesNotMatch(JSON.stringify(calls.at(-1).body.messages), /legacy trace/);
    for (const extra of [{ thinking: { type: "disabled" } }, { reasoning_effort: "none" }, { reasoning_split: false }]) {
      assert.equal((await invoke({ model: "MiniMax-M3.1-Flash-Preview", messages, ...extra })).status, 400);
    }
    await invoke({ model: "MiniMax-M3", messages, thinking: { type: "disabled" } });
    assert.equal(calls.at(-1).body.thinking.type, "disabled");
  });

  it("replays current MiniMax M3 reasoning_content during a tool loop", async () => {
    responder = (body) => completion(body, { content: null, reasoning_content: "tool trace", tool_calls: [toolCall] });
    const first = await (await invoke({ model: "MiniMax-M3", messages, tools })).json();
    responder = (body) => completion(body);
    await invoke({ model: "MiniMax-M3", messages: [...messages, first.choices[0].message, { role: "tool", tool_call_id: toolCall.id, content: "ok" }], tools });
    assert.equal(calls.at(-1).body.messages[1].reasoning_content, "tool trace");
    assert.equal(calls.at(-1).body.messages[1].reasoning_details, undefined);
    assert.deepEqual(calls.at(-1).body.messages[1].tool_calls, [toolCall]);
  });

  it("applies GPT-6 Responses effort, sampling and caching after env precedence", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_REASONING_EFFORT = "none";
    responder = (body) => ({ id: "resp_refresh", model: body.model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 7 } } });
    const response = await invoke({ model: "compatible-gpt-6.1-sol", messages, tools, reasoning_effort: "max", temperature: 1, top_p: 0.5,
      include: ["message.output_text.logprobs", "reasoning.encrypted_content"], prompt_cache_retention: "24h" });
    const body = calls.at(-1).body;
    assert.match(calls.at(-1).url, /\/v1\/responses$/);
    assert.equal(body.reasoning.effort, "low");
    assert.equal(body.temperature, undefined);
    assert.equal(body.top_p, undefined);
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(body.prompt_cache_options, { ttl: "30m" });
    assert.equal(body.prompt_cache_retention, undefined);
    assert.equal(body.tools[0].name, "echo");
    const json = await response.json();
    assert.equal(json.model, "cursorproxy/compatible-gpt-6.1-sol");
    assert.deepEqual(json.usage.prompt_tokens_details, { cached_tokens: 3, cache_write_tokens: 7 });
  });
  it("keeps GPT-6 Chat tool restrictions explicit and custom gateway behavior intact", async () => {
    for (const model of ["gpt-6.1-sol", "gpt-6-astra"]) {
      const response = await invoke({ model, messages, tools }, "openaicompat");
      assert.equal(response.status, 400);
      assert.match(await response.text(), /OPENAICOMPAT_WIRE_API=responses/);
    }
    assert.equal(calls.length, 0);
    await invoke({ model: "gpt-6-luna", messages, tools, reasoning_effort: "none", temperature: 0.2, logprobs: true }, "openaicompat");
    assert.equal(calls.at(-1).body.temperature, 0.2);
    assert.equal(calls.at(-1).body.logprobs, true);
    process.env.UPSTREAM_OPENAICOMPAT = "https://gateway.test";
    await invoke({ model: "gpt-6.1-sol", messages, tools, reasoning_effort: "none", temperature: 0.3, prompt_cache_retention: "24h" }, "openaicompat");
    assert.equal(calls.at(-1).body.reasoning_effort, "none");
    assert.equal(calls.at(-1).body.temperature, 0.3);
    assert.equal(calls.at(-1).body.prompt_cache_retention, "24h");
  });
  it("supports Azure GPT-6 aliases and max without imposing public OpenAI none rules", async () => {
    process.env.AZURE_OPENAI_GENERAL_ALIAS_TARGET = "gpt-6.1-sol";
    process.env.AZURE_OPENAI_REASONING_EFFORT = "max";
    await invoke({ model: "gpt-general", messages, temperature: 0.7 });
    assert.equal(calls.at(-1).body.model, "gpt-6.1-sol");
    assert.equal(calls.at(-1).body.reasoning.effort, "max");
    assert.equal(calls.at(-1).body.temperature, undefined);
    process.env.AZURE_OPENAI_GENERAL_REASONING_EFFORT = "none";
    await invoke({ model: "gpt-general", messages, temperature: 0.7 });
    assert.equal(calls.at(-1).body.reasoning.effort, "none");
    assert.equal(calls.at(-1).body.temperature, 0.7);
  });
  for (const model of gptModels) {
    it(`streams ${model} tools, usage and public model identity, then accepts the tool result`, async () => {
      process.env.OPENAICOMPAT_WIRE_API = "responses";
      const args = '{"value":"ok"}';
      responder = () => sse([
        { type: "response.created", response: { id: "resp_gpt6", status: "in_progress", model } },
        { type: "response.output_item.added", output_index: 2, item: { id: "fc_echo", type: "function_call", call_id: "call_echo", name: "echo" } },
        { type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_echo", delta: args },
        { type: "response.function_call_arguments.done", output_index: 2, item_id: "fc_echo", arguments: args },
        { type: "response.completed", response: { id: "resp_gpt6", status: "completed", error: null,
          usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 10 } } } },
      ]);
      const response = await invoke({ model: `compatible-${model}`, messages, tools, stream: true, stream_options: { include_usage: true } });
      const output = await response.text();
      assert.equal(response.status, 200);
      assert.equal((output.match(/data: \[DONE\]/g) || []).length, 1);
      const chunks = output.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
      const emitted = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || []);
      assert.ok(emitted.length > 0);
      assert.ok(emitted.every((c) => c.index === 0));
      assert.equal(emitted[0].id, "call_echo");
      assert.equal(emitted[0].function.name, "echo");
      assert.equal(emitted.map((c) => c.function.arguments || "").join(""), args);
      assert.ok(chunks.some((c) => c.choices?.[0]?.finish_reason === "tool_calls"));
      assert.ok(chunks.some((c) => c.usage?.prompt_tokens_details?.cache_write_tokens === 10));
      assert.ok(chunks.some((c) => c.model === `cursorproxy/compatible-${model}`));
      responder = (body) => ({ id: "resp_followup", model: body.model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] });
      const next = await invoke({ model: `compatible-${model}`, messages: [...messages,
        { role: "assistant", content: null, tool_calls: [toolCall] }, { role: "tool", tool_call_id: "call_echo", content: "ok" }], tools });
      assert.equal(next.status, 200);
      assert.ok(calls.at(-1).body.input.some((item) => item.type === "function_call_output" && item.call_id === "call_echo" && item.output === "ok"));
    });
  }
  it("preserves explicit GPT-6 cache options and none sampling through the Responses whitelist", async () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    await invoke({ model: "compatible-gpt-6-luna", messages, reasoning: { effort: "none" }, temperature: 0.4,
      top_logprobs: 2, include: ["message.output_text.logprobs"], prompt_cache_options: {}, prompt_cache_retention: "24h" });
    assert.equal(calls.at(-1).body.top_logprobs, 2);
    assert.equal(calls.at(-1).body.temperature, 0.4);
    assert.deepEqual(calls.at(-1).body.include, ["message.output_text.logprobs"]);
    assert.deepEqual(calls.at(-1).body.prompt_cache_options, {});
    assert.equal(calls.at(-1).body.prompt_cache_retention, undefined);
  });
  it("uses GPT-6 Luna's Chat parameters for the optional OpenAI vision backend", async () => {
    process.env.VISION_API_PROVIDER = "openai";
    // Vision config is intentionally captured at import, as in a deployment restart.
    const { describeImage } = await import("../lib/vision.js?refresh-openai-vision");
    assert.equal(await describeImage(imageMessages[0].content[1].image_url.url), "ok");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.model, "gpt-6-luna");
    assert.equal(calls[0].body.max_completion_tokens, 2048);
    assert.equal(calls[0].body.reasoning_effort, "none");
    assert.equal(calls[0].body.max_tokens, undefined);
    assert.deepEqual(calls[0].body.messages[0].content[1], imageMessages[0].content[1]);
  });
  it("derives GPT-6 opt-in cache keys from the effective public effort", async () => {
    const req = new Request("https://proxy.test", { headers: { session_id: "refresh" } });
    const a = await deriveOpenAICompatResponsesHaloPromptCacheKey(req, { model: "gpt-6.1-sol", messages, reasoning_effort: "none" }, "gpt-6.1-sol");
    const b = await deriveOpenAICompatResponsesHaloPromptCacheKey(req, { model: "gpt-6.1-sol", messages, reasoning_effort: "low" }, "gpt-6.1-sol");
    assert.ok(a.key);
    assert.equal(a.key, b.key);
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "sub2api";
    await invoke({ model: "compatible-gpt-6-luna", messages });
    assert.match(calls.at(-1).body.prompt_cache_key, /^compat_cc_/);
  });

  it("validates new Claude thinking, effort and forced tools while retaining Haiku tools", async () => {
    for (const model of claudeModels) {
      assert.equal((await invoke({ model, messages, thinking: { type: "enabled", budget_tokens: 1024 } })).status, 400);
      await invoke({ model, messages, temperature: 0.5, top_p: 0.8, top_k: 3, reasoning_effort: "xhigh" });
      assert.equal(calls.at(-1).body.output_config.effort, "xhigh");
      for (const key of ["temperature", "top_p", "top_k"]) assert.equal(calls.at(-1).body[key], undefined);
      await invoke({ model, input: messages, thinking: { type: "adaptive", display: "summarized" } });
      assert.deepEqual(calls.at(-1).body.messages, messages);
      assert.deepEqual(calls.at(-1).body.thinking, { type: "adaptive", display: "summarized" });
    }
    for (const choice of ["required", { type: "any" }, { type: "tool", name: "echo" }, { type: "function", function: { name: "echo" } }]) {
      assert.equal((await invoke({ model: "claude-sonnet-5-5", messages, tools: nativeTools, tool_choice: choice })).status, 400);
      assert.equal((await invoke({ model: "claude-haiku-5-5", messages, tools: nativeTools, tool_choice: choice })).status, 200);
      assert.ok(["any", "tool"].includes(calls.at(-1).body.tool_choice.type));
    }
    await invoke({ model: "claude-sonnet-5-5", messages, thinking: { type: "between_tools" }, reasoning_effort: "high" });
    assert.equal(calls.at(-1).body.thinking.type, "between_tools");
    assert.equal((await invoke({ model: "claude-sonnet-5-5", messages, thinking: { type: "between_tools" }, reasoning_effort: "max" })).status, 400);
    assert.equal((await invoke({ model: "claude-sonnet-5-5", messages, thinking: { type: "between_tools", display: "omitted" } })).status, 400);
    assert.equal((await invoke({ model: "claude-haiku-5-5", messages, thinking: { type: "disabled" }, reasoning_effort: "max" })).status, 400);
    assert.equal((await invoke({ model: "claude-haiku-5-5", messages, thinking: { type: "disabled" }, reasoning_effort: "high" })).status, 200);
    process.env.AZURE_ANTHROPIC_THINKING = "disabled";
    assert.equal((await invoke({ messages }, "azureanthropic")).status, 400);
    assert.equal((await invoke({ model: "claude-sonnet-4-6", messages })).status, 200);
  });
  for (const stream of [false, true]) {
    it(`replays signature-only Claude thinking with default thinking (${stream ? "SSE" : "JSON"}) and isolates context`, async () => {
      const block = { type: "thinking", thinking: "", signature: "signature-for-this-context" };
      const model = "claude-sonnet-5-5";
      const initial = { model, messages, system: "Use echo", tools: nativeTools };
      responder = (body) => stream ? sse([
        { type: "message_start", message: { id: "msg_refresh", role: "assistant" } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: block.signature } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" },
      ]) : anthropic(body, [block, { type: "text", text: "ok" }]);
      const output = await (await invoke({ ...initial, stream })).text();
      assert.doesNotMatch(output, /signature-for-this-context/);
      assert.equal([...kv.keys()].filter((k) => k.startsWith("claude_thinking:")).length, 1);
      responder = (body) => anthropic(body);
      const next = { ...initial, messages: [...messages, { role: "assistant", content: "ok" }, { role: "user", content: "Continue" }] };
      await invoke(next);
      assert.deepEqual(calls.at(-1).body.messages[1].content[0], block);
      for (const change of [{ model: "claude-opus-5-5" }, { system: "Different system" }, { tools: [] }]) {
        await invoke({ ...next, ...change });
        assert.equal(calls.at(-1).body.messages[1].content, "ok");
      }
      process.env.AZURE_FOUNDRY_API_KEY = "different-account";
      await invoke(next);
      assert.equal(calls.at(-1).body.messages[1].content, "ok");
      process.env.AZURE_FOUNDRY_API_KEY = "fixture-key";
      process.env.AZURE_ANTHROPIC_ENDPOINT = "https://another.services.ai.azure.com";
      await invoke(next);
      assert.equal(calls.at(-1).body.messages[1].content, "ok");
    });
  }
});
