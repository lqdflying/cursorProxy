import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sanitizeGlmBody } from "../lib/glm.js";
import { isNativeGlmEndpoint } from "../lib/providers.js";

// Native Z.AI/ZHIPU Coding Plan hosts vs compatible third-party gateways.
// GLM-native fields (`thinking`, `tool_stream`) must be injected only for
// native hosts; gateways (litellm, Hosted_vLLM, ...) reject them with HTTP 400
// on plain requests. See .cursor/rules/glm-native-detection.mdc for the
// probe evidence that established this matrix.
const NATIVE_BIGMODEL =
  "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions";
const NATIVE_ZAI = "https://api.z.ai/api/coding/paas/v4/chat/completions";
const GATEWAY = "https://ai.nube.sh/api/v1/chat/completions";

afterEach(() => {
  delete process.env.GLM_NATIVE_FIELDS;
});

function baseBody(overrides = {}) {
  return {
    model: "glm-5.2",
    stream: true,
    messages: [{ role: "user", content: "reply ok" }],
    tools: [
      {
        type: "function",
        function: { name: "noop", description: "d", parameters: { type: "object", properties: {} } },
      },
    ],
    ...overrides,
  };
}

describe("isNativeGlmEndpoint", () => {
  it("accepts ZHIPU China Coding Plan host", () => {
    assert.equal(isNativeGlmEndpoint(NATIVE_BIGMODEL), true);
  });

  it("accepts Z.AI Global Coding Plan host", () => {
    assert.equal(isNativeGlmEndpoint(NATIVE_ZAI), true);
  });

  it("rejects a compatible gateway host", () => {
    assert.equal(isNativeGlmEndpoint(GATEWAY), false);
  });

  it("is hostname-based, not path-based (ignores /api/coding/paas/v4 path on gateway)", () => {
    // A gateway that mirrors the ZHIPU path must NOT be treated as native.
    assert.equal(
      isNativeGlmEndpoint("https://gateway.example.com/api/coding/paas/v4/chat/completions"),
      false,
    );
  });

  it("is case-insensitive on hostname", () => {
    assert.equal(isNativeGlmEndpoint("https://OPEN.BIGMODEL.CN/x"), true);
  });

  it("rejects malformed input without throwing", () => {
    assert.equal(isNativeGlmEndpoint("not-a-url"), false);
    assert.equal(isNativeGlmEndpoint(""), false);
    assert.equal(isNativeGlmEndpoint(undefined), false);
    assert.equal(isNativeGlmEndpoint(null), false);
  });
});

describe("sanitizeGlmBody — native fields on native host", () => {
  it("injects thinking for native host", () => {
    const b = baseBody();
    sanitizeGlmBody(b, "glm-5.2", NATIVE_BIGMODEL);
    assert.deepEqual(b.thinking, { type: "enabled", clear_thinking: false });
  });

  it("injects tool_stream when stream + tools on native host", () => {
    const b = baseBody();
    sanitizeGlmBody(b, "glm-5.2", NATIVE_ZAI);
    assert.equal(b.tool_stream, true);
  });

  it("does not inject tool_stream when stream is false", () => {
    const b = baseBody({ stream: false });
    sanitizeGlmBody(b, "glm-5.2", NATIVE_BIGMODEL);
    assert.equal(b.tool_stream, undefined);
    // thinking still injected
    assert.equal(b.thinking?.type, "enabled");
  });

  it("does not inject tool_stream when tools are absent", () => {
    const b = baseBody();
    delete b.tools;
    sanitizeGlmBody(b, "glm-5.2", NATIVE_BIGMODEL);
    assert.equal(b.tool_stream, undefined);
  });

  it("preserves a client-sent thinking value (does not overwrite)", () => {
    const b = baseBody({ thinking: { type: "enabled", clear_thinking: true } });
    sanitizeGlmBody(b, "glm-5.2", NATIVE_BIGMODEL);
    assert.deepEqual(b.thinking, { type: "enabled", clear_thinking: true });
  });
});

describe("sanitizeGlmBody — native fields stripped on gateway", () => {
  it("strips thinking on a gateway (no thinking field after sanitize)", () => {
    const b = baseBody();
    sanitizeGlmBody(b, "glm-5.2", GATEWAY);
    assert.equal(Object.prototype.hasOwnProperty.call(b, "thinking"), false);
  });

  it("strips tool_stream on a gateway when stream + tools are present", () => {
    const b = baseBody();
    sanitizeGlmBody(b, "glm-5.2", GATEWAY);
    assert.equal(Object.prototype.hasOwnProperty.call(b, "tool_stream"), false);
  });

  it("strips a client-sent thinking on a gateway", () => {
    // The probe showed `thinking` alone is rejected 3/3 on the gateway even
    // though the sanitizer's inject path never runs when the client set it.
    const b = baseBody({ thinking: { type: "enabled", clear_thinking: false } });
    sanitizeGlmBody(b, "glm-5.2", GATEWAY);
    assert.equal(Object.prototype.hasOwnProperty.call(b, "thinking"), false);
  });

  it("strips a client-sent tool_stream on a gateway even without tools/stream", () => {
    const b = baseBody({ stream: false });
    delete b.tools;
    b.tool_stream = true;
    sanitizeGlmBody(b, "glm-5.2", GATEWAY);
    assert.equal(Object.prototype.hasOwnProperty.call(b, "tool_stream"), false);
  });

  it("still forwards reasoning_effort on a gateway (probed-accepted, GLM-5.2+ feature)", () => {
    const b = baseBody();
    sanitizeGlmBody(b, "glm-5.2", GATEWAY);
    assert.equal(b.reasoning_effort, "max");
  });
});

describe("sanitizeGlmBody — GLM_NATIVE_FIELDS env override", () => {
  it("GLM_NATIVE_FIELDS=true forces injection on a gateway", () => {
    process.env.GLM_NATIVE_FIELDS = "true";
    const b = baseBody();
    sanitizeGlmBody(b, "glm-5.2", GATEWAY);
    assert.deepEqual(b.thinking, { type: "enabled", clear_thinking: false });
    assert.equal(b.tool_stream, true);
  });

  it("GLM_NATIVE_FIELDS=1 also forces injection (alias)", () => {
    process.env.GLM_NATIVE_FIELDS = "1";
    const b = baseBody();
    sanitizeGlmBody(b, "glm-5.2", GATEWAY);
    assert.equal(b.thinking?.type, "enabled");
    assert.equal(b.tool_stream, true);
  });

  it("GLM_NATIVE_FIELDS=false forces stripping on native host", () => {
    process.env.GLM_NATIVE_FIELDS = "false";
    const b = baseBody();
    sanitizeGlmBody(b, "glm-5.2", NATIVE_BIGMODEL);
    assert.equal(Object.prototype.hasOwnProperty.call(b, "thinking"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(b, "tool_stream"), false);
  });

  it("GLM_NATIVE_FIELDS=0 also forces stripping (alias)", () => {
    process.env.GLM_NATIVE_FIELDS = "0";
    const b = baseBody();
    sanitizeGlmBody(b, "glm-5.2", NATIVE_ZAI);
    assert.equal(Object.prototype.hasOwnProperty.call(b, "thinking"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(b, "tool_stream"), false);
  });

  it("GLM_NATIVE_FIELDS=auto follows isNativeGlmEndpoint", () => {
    process.env.GLM_NATIVE_FIELDS = "auto";
    const native = baseBody();
    sanitizeGlmBody(native, "glm-5.2", NATIVE_BIGMODEL);
    assert.equal(native.thinking?.type, "enabled");

    const gateway = baseBody();
    sanitizeGlmBody(gateway, "glm-5.2", GATEWAY);
    assert.equal(Object.prototype.hasOwnProperty.call(gateway, "thinking"), false);
  });

  it("GLM_NATIVE_FIELDS=<invalid> falls back to auto", () => {
    process.env.GLM_NATIVE_FIELDS = "yes";
    const native = baseBody();
    sanitizeGlmBody(native, "glm-5.2", NATIVE_BIGMODEL);
    assert.equal(native.thinking?.type, "enabled");

    const gateway = baseBody();
    sanitizeGlmBody(gateway, "glm-5.2", GATEWAY);
    assert.equal(Object.prototype.hasOwnProperty.call(gateway, "thinking"), false);
  });
});

describe("sanitizeGlmBody — tool_choice normalization (unchanged)", () => {
  it("tool_choice:none removes tools, tool_choice, and tool_stream on native", () => {
    const b = baseBody({ tool_choice: "none", tool_stream: true });
    sanitizeGlmBody(b, "glm-5.2", NATIVE_BIGMODEL);
    assert.equal(Object.prototype.hasOwnProperty.call(b, "tools"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(b, "tool_choice"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(b, "tool_stream"), false);
  });

  it("tool_choice:none removes tools, tool_choice, and tool_stream on gateway too", () => {
    const b = baseBody({ tool_choice: "none", tool_stream: true });
    sanitizeGlmBody(b, "glm-5.2", GATEWAY);
    assert.equal(Object.prototype.hasOwnProperty.call(b, "tools"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(b, "tool_choice"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(b, "tool_stream"), false);
  });

  it("coerces a forced tool_choice to auto on native", () => {
    const b = baseBody({ tool_choice: "required" });
    sanitizeGlmBody(b, "glm-5.2", NATIVE_BIGMODEL);
    assert.equal(b.tool_choice, "auto");
  });

  it("coerces a forced tool_choice to auto on gateway too", () => {
    const b = baseBody({ tool_choice: { type: "function", function: { name: "noop" } } });
    sanitizeGlmBody(b, "glm-5.2", GATEWAY);
    assert.equal(b.tool_choice, "auto");
  });
});

describe("sanitizeGlmBody — reasoning_effort model-version gate (unchanged)", () => {
  it("strips reasoning_effort for pre-5.2 GLM even on native host", () => {
    const b = baseBody({ model: "glm-4.7", reasoning_effort: "high" });
    sanitizeGlmBody(b, "glm-4.7", NATIVE_BIGMODEL);
    assert.equal(Object.prototype.hasOwnProperty.call(b, "reasoning_effort"), false);
  });

  it("forwards a valid client reasoning_effort for GLM-5.2+ on a gateway", () => {
    const b = baseBody({ reasoning_effort: "high" });
    sanitizeGlmBody(b, "glm-5.2", GATEWAY);
    assert.equal(b.reasoning_effort, "high");
  });
});

describe("sanitizeGlmBody — non-GLM and edge cases", () => {
  it("returns false (no-op) for a non-GLM model regardless of host", () => {
    const b = baseBody({ model: "deepseek-v4-flash" });
    assert.equal(sanitizeGlmBody(b, "deepseek-v4-flash", GATEWAY), false);
  });

  it("still returns changed=true when only one native field is stripped", () => {
    const b = baseBody({ thinking: { type: "enabled" } });
    delete b.tools;
    b.stream = false;
    const changed = sanitizeGlmBody(b, "glm-5.2", GATEWAY);
    assert.equal(changed, true);
  });

  it("returns false on a gateway when nothing needs changing", () => {
    const b = { model: "glm-5.2", messages: [{ role: "user", content: "hi" }] };
    // No thinking, no tool_stream, no extras; reasoning_effort default is
    // injected though, so this DOES change. Construct one with effort already set.
    const b2 = { model: "glm-5.2", reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] };
    assert.equal(sanitizeGlmBody(b2, "glm-5.2", GATEWAY), false);
  });
});
