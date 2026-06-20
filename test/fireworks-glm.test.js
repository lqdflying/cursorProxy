import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isFireworksGlm52Model,
  resolveFireworksGlmReasoningEffort,
} from "../lib/fireworks.js";
import handler from "../api/proxy.js";

const GLM_52 = "accounts/fireworks/models/glm-5p2";

afterEach(() => {
  delete process.env.FIREWORKS_GLM_REASONING_EFFORT;
});

describe("isFireworksGlm52Model", () => {
  it("detects the documented Fireworks GLM 5.2 IDs", () => {
    assert.equal(isFireworksGlm52Model("accounts/fireworks/models/glm-5p2"), true);
    assert.equal(isFireworksGlm52Model("accounts/fireworks/models/glm-5.2"), true);
    assert.equal(isFireworksGlm52Model("glm-5p2"), true);
    assert.equal(isFireworksGlm52Model("glm-5.2"), true);
  });

  it("rejects undocumented/custom-account GLM 5.2 IDs", () => {
    assert.equal(isFireworksGlm52Model("accounts/acme-corp/models/glm-5p2"), false);
    assert.equal(isFireworksGlm52Model("accounts/acme-corp/models/glm-5.2"), false);
  });

  it("rejects older GLM, future versions, and the vision model", () => {
    assert.equal(isFireworksGlm52Model("accounts/fireworks/models/glm-5p1"), false);
    assert.equal(isFireworksGlm52Model("accounts/fireworks/models/glm-5"), false);
    assert.equal(isFireworksGlm52Model("accounts/fireworks/models/glm-4p7"), false);
    assert.equal(isFireworksGlm52Model("accounts/fireworks/models/glm-5p10"), false);
    assert.equal(isFireworksGlm52Model("accounts/fireworks/models/glm-6"), false);
    assert.equal(isFireworksGlm52Model("accounts/fireworks/models/glm-5v-turbo"), false);
  });

  it("rejects non-GLM Fireworks models and bad input", () => {
    assert.equal(isFireworksGlm52Model("accounts/fireworks/models/deepseek-v4-pro"), false);
    assert.equal(isFireworksGlm52Model("accounts/fireworks/models/llama-v3p1-70b"), false);
    assert.equal(isFireworksGlm52Model(""), false);
    assert.equal(isFireworksGlm52Model(null), false);
  });
});

describe("resolveFireworksGlmReasoningEffort", () => {
  it("injects max by default when reasoning_effort is omitted", () => {
    const body = { model: GLM_52, messages: [] };
    assert.equal(resolveFireworksGlmReasoningEffort(body, GLM_52), true);
    assert.equal(body.reasoning_effort, "max");
  });

  it("keeps a valid client-sent string value unchanged", () => {
    const body = { reasoning_effort: "high" };
    assert.equal(resolveFireworksGlmReasoningEffort(body, GLM_52), false);
    assert.equal(body.reasoning_effort, "high");

    const body2 = { reasoning_effort: "xhigh" };
    assert.equal(resolveFireworksGlmReasoningEffort(body2, GLM_52), false);
    assert.equal(body2.reasoning_effort, "xhigh");
  });

  it("keeps client 'none' so the reasoning gate can disable injection", () => {
    const body = { reasoning_effort: "none" };
    assert.equal(resolveFireworksGlmReasoningEffort(body, GLM_52), false);
    assert.equal(body.reasoning_effort, "none");
  });

  it("converts client false to 'none'", () => {
    const body = { reasoning_effort: false };
    assert.equal(resolveFireworksGlmReasoningEffort(body, GLM_52), true);
    assert.equal(body.reasoning_effort, "none");
  });

  it("converts client true to 'medium'", () => {
    const body = { reasoning_effort: true };
    assert.equal(resolveFireworksGlmReasoningEffort(body, GLM_52), true);
    assert.equal(body.reasoning_effort, "medium");
  });

  it("preserves positive integer reasoning budgets", () => {
    const body = { reasoning_effort: 2048 };
    assert.equal(resolveFireworksGlmReasoningEffort(body, GLM_52), false);
    assert.equal(body.reasoning_effort, 2048);
  });

  it("falls back to max for invalid values", () => {
    for (const raw of ["turbo", "minimal", 0, -1, null, {}]) {
      const body = { reasoning_effort: raw };
      assert.equal(resolveFireworksGlmReasoningEffort(body, GLM_52), true);
      assert.equal(body.reasoning_effort, "max");
    }
  });

  it("env override wins over a client value", () => {
    process.env.FIREWORKS_GLM_REASONING_EFFORT = "medium";
    const body = { reasoning_effort: "high" };
    assert.equal(resolveFireworksGlmReasoningEffort(body, GLM_52), true);
    assert.equal(body.reasoning_effort, "medium");
  });

  it("ignores an invalid env value and uses the normalized client value", () => {
    process.env.FIREWORKS_GLM_REASONING_EFFORT = "bogus";
    const body = { reasoning_effort: "low" };
    assert.equal(resolveFireworksGlmReasoningEffort(body, GLM_52), false);
    assert.equal(body.reasoning_effort, "low");
  });

  it("no-ops for older Fireworks GLM and non-GLM models", () => {
    for (const id of [
      "accounts/fireworks/models/glm-5p1",
      "accounts/fireworks/models/glm-4p7",
      "accounts/fireworks/models/deepseek-v4-pro",
      "accounts/fireworks/models/llama-v3p1-70b",
    ]) {
      const body = { reasoning_effort: "high" };
      assert.equal(resolveFireworksGlmReasoningEffort(body, id), false);
      assert.equal(body.reasoning_effort, "high"); // untouched
    }

    const omitted = { messages: [] };
    assert.equal(
      resolveFireworksGlmReasoningEffort(omitted, "accounts/fireworks/models/glm-5p1"),
      false,
    );
    assert.equal("reasoning_effort" in omitted, false); // no default injected
  });

  it("returns false for empty body", () => {
    assert.equal(resolveFireworksGlmReasoningEffort(null, GLM_52), false);
  });

  it("always logs the resolved effort for GLM 5.2+, and never for no-ops", () => {
    const lines = [];
    const orig = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      // Valid client value: body unchanged (returns false) but still logged.
      resolveFireworksGlmReasoningEffort({ reasoning_effort: "high" }, GLM_52);
      // Env matching the existing value: also unchanged but still logged.
      process.env.FIREWORKS_GLM_REASONING_EFFORT = "high";
      resolveFireworksGlmReasoningEffort({ reasoning_effort: "high" }, GLM_52);
      delete process.env.FIREWORKS_GLM_REASONING_EFFORT;
      // No-op model: must not emit an effort line.
      resolveFireworksGlmReasoningEffort(
        { reasoning_effort: "high" },
        "accounts/fireworks/models/llama-v3p1-70b",
      );
    } finally {
      console.log = orig;
    }
    const effortLines = lines.filter((l) => l.includes("FIREWORKS_GLM_EFFORT"));
    assert.equal(effortLines.length, 2);
    assert.ok(effortLines.every((l) => l.includes("reasoningEffort: high")));
  });
});

describe("handler outbound body for Fireworks GLM 5.2", () => {
  const origFetch = global.fetch;
  const origEnv = process.env.FIREWORKS_API_KEY;

  afterEach(async () => {
    global.fetch = origFetch;
    if (origEnv === undefined) {
      delete process.env.FIREWORKS_API_KEY;
    } else {
      process.env.FIREWORKS_API_KEY = origEnv;
    }
  });

  async function captureOutboundBody(requestBody, envVars = {}) {
    process.env.FIREWORKS_API_KEY = "fw-test-key";
    for (const [k, v] of Object.entries(envVars)) {
      process.env[k] = v;
    }

    let capturedBody = null;
    global.fetch = async (_url, init) => {
      capturedBody = init.body;
      return new Response(
        JSON.stringify({
          id: "test-resp",
          object: "chat.completion",
          model: "accounts/fireworks/models/glm-5p2",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const req = new Request("http://localhost/fireworks/v1/chat/completions?provider=fireworks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    const res = await handler(req);
    assert.equal(res.status, 200);
    return JSON.parse(capturedBody);
  }

  it("injects reasoning_effort: max when omitted", async () => {
    const body = await captureOutboundBody({
      model: "glm-5p2",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(body.model, "accounts/fireworks/models/glm-5p2");
    assert.equal(body.reasoning_effort, "max");
  });

  it("preserves client-sent 'none'", async () => {
    const body = await captureOutboundBody({
      model: "glm-5p2",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "none",
    });
    assert.equal(body.reasoning_effort, "none");
  });

  it("converts client false to 'none'", async () => {
    const body = await captureOutboundBody({
      model: "glm-5p2",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: false,
    });
    assert.equal(body.reasoning_effort, "none");
  });

  it("converts client true to 'medium'", async () => {
    const body = await captureOutboundBody({
      model: "glm-5p2",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: true,
    });
    assert.equal(body.reasoning_effort, "medium");
  });

  it("preserves positive integer budgets", async () => {
    const body = await captureOutboundBody({
      model: "glm-5p2",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: 4096,
    });
    assert.equal(body.reasoning_effort, 4096);
  });

  it("applies env override", async () => {
    const body = await captureOutboundBody(
      {
        model: "glm-5p2",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "high",
      },
      { FIREWORKS_GLM_REASONING_EFFORT: "low" },
    );
    assert.equal(body.reasoning_effort, "low");
  });

  it("leaves non-target Fireworks models untouched", async () => {
    const body = await captureOutboundBody({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    });
    assert.equal(body.model, "accounts/fireworks/models/deepseek-v4-pro");
    assert.equal(body.reasoning_effort, "high");
  });
});
