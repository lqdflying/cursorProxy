import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isFireworksGlm52Plus,
  resolveFireworksGlmReasoningEffort,
} from "../lib/fireworks.js";

const GLM_52 = "accounts/fireworks/models/glm-5p2";

afterEach(() => {
  delete process.env.FIREWORKS_GLM_REASONING_EFFORT;
});

describe("isFireworksGlm52Plus", () => {
  it("detects GLM 5.2+ from fully-qualified Fireworks ids (p separator)", () => {
    assert.equal(isFireworksGlm52Plus("accounts/fireworks/models/glm-5p2"), true);
    assert.equal(isFireworksGlm52Plus("accounts/fireworks/models/glm-5p10"), true);
    assert.equal(isFireworksGlm52Plus("accounts/fireworks/models/glm-6"), true);
    assert.equal(isFireworksGlm52Plus("accounts/fireworks/models/glm-6p0"), true);
  });

  it("also accepts the dot-separated form", () => {
    assert.equal(isFireworksGlm52Plus("accounts/fireworks/models/glm-5.2"), true);
  });

  it("rejects older GLM and the vision model", () => {
    assert.equal(isFireworksGlm52Plus("accounts/fireworks/models/glm-5p1"), false);
    assert.equal(isFireworksGlm52Plus("accounts/fireworks/models/glm-5"), false);
    assert.equal(isFireworksGlm52Plus("accounts/fireworks/models/glm-4p7"), false);
    assert.equal(isFireworksGlm52Plus("accounts/fireworks/models/glm-5v-turbo"), false);
  });

  it("rejects non-GLM Fireworks models and bad input", () => {
    assert.equal(isFireworksGlm52Plus("accounts/fireworks/models/deepseek-v4-pro"), false);
    assert.equal(isFireworksGlm52Plus("accounts/fireworks/models/llama-v3p1-70b"), false);
    assert.equal(isFireworksGlm52Plus("glm-5p2"), true); // bare also works
    assert.equal(isFireworksGlm52Plus(""), false);
    assert.equal(isFireworksGlm52Plus(null), false);
  });
});

describe("resolveFireworksGlmReasoningEffort", () => {
  it("injects max by default when reasoning_effort is omitted", () => {
    const body = { model: GLM_52, messages: [] };
    assert.equal(resolveFireworksGlmReasoningEffort(body, GLM_52), true);
    assert.equal(body.reasoning_effort, "max");
  });

  it("keeps a valid client-sent value unchanged (returns false)", () => {
    const body = { reasoning_effort: "high" };
    assert.equal(resolveFireworksGlmReasoningEffort(body, GLM_52), false);
    assert.equal(body.reasoning_effort, "high");

    const body2 = { reasoning_effort: "xhigh" };
    assert.equal(resolveFireworksGlmReasoningEffort(body2, GLM_52), false);
    assert.equal(body2.reasoning_effort, "xhigh");
  });

  it("keeps client none so the reasoning gate can disable injection", () => {
    const body = { reasoning_effort: "none" };
    assert.equal(resolveFireworksGlmReasoningEffort(body, GLM_52), false);
    assert.equal(body.reasoning_effort, "none");
  });

  it("falls back to max for an invalid client value", () => {
    const body = { reasoning_effort: "turbo" };
    assert.equal(resolveFireworksGlmReasoningEffort(body, GLM_52), true);
    assert.equal(body.reasoning_effort, "max");
  });

  it("does not accept minimal (unsupported on Fireworks GLM)", () => {
    const body = { reasoning_effort: "minimal" };
    assert.equal(resolveFireworksGlmReasoningEffort(body, GLM_52), true);
    assert.equal(body.reasoning_effort, "max");
  });

  it("env override wins over a client value", () => {
    process.env.FIREWORKS_GLM_REASONING_EFFORT = "medium";
    const body = { reasoning_effort: "high" };
    assert.equal(resolveFireworksGlmReasoningEffort(body, GLM_52), true);
    assert.equal(body.reasoning_effort, "medium");
  });

  it("ignores an invalid env value and uses the default", () => {
    process.env.FIREWORKS_GLM_REASONING_EFFORT = "bogus";
    const body = { model: GLM_52 };
    assert.equal(resolveFireworksGlmReasoningEffort(body, GLM_52), true);
    assert.equal(body.reasoning_effort, "max");
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
