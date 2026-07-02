import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  deriveCompatPromptCacheKey,
  deriveOpenAICompatSessionAnchor,
  deriveOpenAIContentSessionSeed,
  normalizeCompatSeedJSON,
  openAICompatCacheHitMode,
  shouldAutoInjectPromptCacheKeyForCompat,
} from "../lib/openaicompat-cache.js";

describe("openaicompat sub2api cache helpers", () => {
  const origMode = process.env.OPENAICOMPAT_CACHE_HIT_MODE;
  const origEffort = process.env.OPENAICOMPAT_REASONING_EFFORT;

  afterEach(() => {
    if (origMode === undefined) delete process.env.OPENAICOMPAT_CACHE_HIT_MODE;
    else process.env.OPENAICOMPAT_CACHE_HIT_MODE = origMode;
    if (origEffort === undefined) delete process.env.OPENAICOMPAT_REASONING_EFFORT;
    else process.env.OPENAICOMPAT_REASONING_EFFORT = origEffort;
  });

  it("parses cache hit mode with safe fallback", () => {
    delete process.env.OPENAICOMPAT_CACHE_HIT_MODE;
    assert.equal(openAICompatCacheHitMode(), "default");
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = " sub2api ";
    assert.equal(openAICompatCacheHitMode(), "sub2api");
    process.env.OPENAICOMPAT_CACHE_HIT_MODE = "bogus";
    assert.equal(openAICompatCacheHitMode(), "default");
  });

  it("gates auto prompt_cache_key injection to GPT-5/Codex models", () => {
    assert.equal(shouldAutoInjectPromptCacheKeyForCompat("gpt-5.5"), true);
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
});
