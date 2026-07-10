import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  deriveCompatPromptCacheKey,
  deriveOpenAICompatChatRemotePromptCacheKey,
  deriveOpenAICompatChatRemoteSessionHeader,
  deriveOpenAICompatSessionAnchor,
  deriveOpenAIContentSessionSeed,
  hasInvalidOpenAICompatCacheHitModeEnv,
  isOpenAICompatChatCacheRemoteMode,
  normalizeOpenAICompatChatCacheUsage,
  normalizeCompatSeedJSON,
  openAICompatChatCacheMode,
  openAICompatCacheHitMode,
  openAICompatChatCachedTokens,
  shouldAutoInjectPromptCacheKeyForCompat,
} from "../lib/openaicompat-cache.js";

describe("openaicompat cache helpers", () => {
  const origMode = process.env.OPENAICOMPAT_CACHE_HIT_MODE;
  const origChatMode = process.env.OPENAICOMPAT_CHAT_CACHE_MODE;
  const origEffort = process.env.OPENAICOMPAT_REASONING_EFFORT;

  afterEach(() => {
    if (origMode === undefined) delete process.env.OPENAICOMPAT_CACHE_HIT_MODE;
    else process.env.OPENAICOMPAT_CACHE_HIT_MODE = origMode;
    if (origChatMode === undefined) delete process.env.OPENAICOMPAT_CHAT_CACHE_MODE;
    else process.env.OPENAICOMPAT_CHAT_CACHE_MODE = origChatMode;
    if (origEffort === undefined) delete process.env.OPENAICOMPAT_REASONING_EFFORT;
    else process.env.OPENAICOMPAT_REASONING_EFFORT = origEffort;
  });

  it("parses cache hit mode and reports invalid values", () => {
    delete process.env.OPENAICOMPAT_CACHE_HIT_MODE;
    assert.equal(openAICompatCacheHitMode(), "default");
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = " sub2api ";
    assert.equal(openAICompatCacheHitMode(), "sub2api");
    assert.equal(hasInvalidOpenAICompatCacheHitModeEnv(), false);
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = " halo ";
    assert.equal(openAICompatCacheHitMode(), "halo");
    assert.equal(hasInvalidOpenAICompatCacheHitModeEnv(), false);
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "remote";
    assert.equal(openAICompatCacheHitMode(), "");
    assert.equal(hasInvalidOpenAICompatCacheHitModeEnv(), true);
  });

  it("parses chat cache mode with safe fallback", () => {
    delete process.env.OPENAICOMPAT_CHAT_CACHE_MODE;
    assert.equal(openAICompatChatCacheMode(), "passthrough");
    process.env.OPENAICOMPAT_CHAT_CACHE_MODE = " facade ";
    assert.equal(openAICompatChatCacheMode(), "facade");
    process.env.OPENAICOMPAT_CHAT_CACHE_MODE = " remote ";
    assert.equal(openAICompatChatCacheMode(), "remote");
    assert.equal(isOpenAICompatChatCacheRemoteMode(), true);
    process.env.OPENAICOMPAT_CHAT_CACHE_MODE = "bogus";
    assert.equal(openAICompatChatCacheMode(), "passthrough");
  });

  it("extracts raw Chat cache hit counters from provider-specific usage fields", () => {
    assert.equal(openAICompatChatCachedTokens({
      usage: { prompt_tokens_details: { cached_tokens: 11 }, cached_tokens: 99 },
    }), 11);
    assert.equal(openAICompatChatCachedTokens({
      usage: { input_tokens_details: { cached_tokens: 22 } },
    }), 22);
    assert.equal(openAICompatChatCachedTokens({
      usage: { cached_tokens: "33" },
    }), 33);
    assert.equal(openAICompatChatCachedTokens({
      usage: { prompt_cache_hit_tokens: 44 },
    }), 44);
    assert.equal(openAICompatChatCachedTokens({
      choices: [{ usage: { cached_tokens: 55 } }],
    }), 55);
    assert.equal(openAICompatChatCachedTokens({
      timings: { cache_n: 66 },
    }), 66);
    assert.equal(openAICompatChatCachedTokens({
      usage: { cached_tokens: "   " },
    }), null);
  });

  it("normalizes raw Chat cache hit counters into prompt token details", () => {
    const body = {
      id: "chatcmpl_1",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_cache_hit_tokens: 80,
      },
    };
    const result = normalizeOpenAICompatChatCacheUsage(body);
    assert.equal(result.changed, true);
    assert.equal(result.cachedTokens, 80);
    assert.equal(body.usage.prompt_tokens_details.cached_tokens, 80);
    assert.equal(body.usage.prompt_tokens, 100);
  });

  it("gates auto prompt_cache_key injection to GPT-5/Codex models", () => {
    assert.equal(shouldAutoInjectPromptCacheKeyForCompat("gpt-5.5"), true);
    assert.equal(shouldAutoInjectPromptCacheKeyForCompat("gpt-5.6-sol"), true);
    assert.equal(shouldAutoInjectPromptCacheKeyForCompat("codex-mini"), true);
    assert.equal(shouldAutoInjectPromptCacheKeyForCompat("gpt-4o"), false);
  });

  it("canonicalizes object keys before deriving prompt cache keys", async () => {
    const a = {
      model: "gpt-5.5",
      tools: [{ type: "function", name: "edit", parameters: { z: 1, a: { b: 2, a: 1 } } }],
      messages: [{ role: "user", content: [{ text: "hi", type: "text" }] }],
    };
    const b = {
      model: "gpt-5.5",
      tools: [{ name: "edit", parameters: { a: { a: 1, b: 2 }, z: 1 }, type: "function" }],
      messages: [{ content: [{ type: "text", text: "hi" }], role: "user" }],
    };

    assert.equal(normalizeCompatSeedJSON(a.tools), normalizeCompatSeedJSON(b.tools));
    const keyA = await deriveCompatPromptCacheKey(a, "gpt-5.5");
    const keyB = await deriveCompatPromptCacheKey(b, "gpt-5.5");
    assert.match(keyA, /^compat_cc_[0-9a-f]{32}$/);
    assert.equal(keyA, keyB);
  });

  it("uses effective env reasoning effort when deriving prompt cache keys", async () => {
    const req = {
      model: "gpt-5.5",
      reasoning_effort: "low",
      messages: [{ role: "user", content: "hi" }],
    };
    const low = await deriveCompatPromptCacheKey(req, "gpt-5.5");
    process.env.OPENAICOMPAT_REASONING_EFFORT = "high";
    const high = await deriveCompatPromptCacheKey(req, "gpt-5.5");
    assert.notEqual(low, high);
  });

  it("derives session anchors by explicit header, prompt key, then content seed", async () => {
    const body = {
      model: "gpt-5.5",
      prompt_cache_key: "client-key",
      messages: [{ role: "user", content: "hi" }],
    };
    const explicit = await deriveOpenAICompatSessionAnchor(
      new Request("http://localhost", { headers: { session_id: "sess-1" } }),
      body,
      "gpt-5.5"
    );
    assert.match(explicit, /^session_id_[0-9a-f]{32}$/);

    const prompt = await deriveOpenAICompatSessionAnchor(
      new Request("http://localhost"),
      body,
      "gpt-5.5"
    );
    assert.match(prompt, /^prompt_cache_key_[0-9a-f]{32}$/);

    const content = await deriveOpenAIContentSessionSeed({ model: "gpt-4o", input: "hello" }, "gpt-4o");
    assert.match(content, /^compat_cs_[0-9a-f]{32}$/);
  });

  it("derives Chat remote prompt cache keys by explicit key, session, conversation, then content", async () => {
    const body = {
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "be concise" },
        { role: "user", content: "hi" },
      ],
    };

    const explicit = await deriveOpenAICompatChatRemotePromptCacheKey(
      new Request("http://localhost"),
      { ...body, prompt_cache_key: "client-key" },
      "gpt-5.5"
    );
    assert.deepEqual(explicit, { key: "client-key", source: "client" });

    const session = await deriveOpenAICompatChatRemotePromptCacheKey(
      new Request("http://localhost", { headers: { session_id: "sess-1" } }),
      body,
      "gpt-5.5"
    );
    assert.equal(session.source, "session_id");
    assert.match(session.key, /^remote_session_id_[0-9a-f]{32}$/);

    const conversation = await deriveOpenAICompatChatRemotePromptCacheKey(
      new Request("http://localhost", { headers: { conversation_id: "conv-1" } }),
      body,
      "gpt-5.5"
    );
    assert.equal(conversation.source, "conversation_id");
    assert.match(conversation.key, /^remote_conversation_id_[0-9a-f]{32}$/);

    const content = await deriveOpenAICompatChatRemotePromptCacheKey(
      new Request("http://localhost"),
      body,
      "gpt-5.5"
    );
    assert.equal(content.source, "content");
    assert.match(content.key, /^remote_cs_[0-9a-f]{32}$/);
  });

  it("derives Chat remote upstream Session_id by client header then prompt cache key", async () => {
    const explicit = await deriveOpenAICompatChatRemoteSessionHeader(
      new Request("http://localhost", { headers: { session_id: "sess-1" } }),
      { key: "remote_key", source: "content" }
    );
    assert.equal(explicit.value, "sess-1");
    assert.equal(explicit.source, "session_id");
    assert.match(explicit.hash, /^[0-9a-f]{16}$/);

    const derived = await deriveOpenAICompatChatRemoteSessionHeader(
      new Request("http://localhost"),
      { key: "remote_key", source: "content" }
    );
    assert.equal(derived.value, "remote_key");
    assert.equal(derived.source, "content");
    assert.match(derived.hash, /^[0-9a-f]{16}$/);

    const empty = await deriveOpenAICompatChatRemoteSessionHeader(
      new Request("http://localhost"),
      { key: "", source: "none" }
    );
    assert.deepEqual(empty, { value: "", source: "none", hash: "" });
  });
});
