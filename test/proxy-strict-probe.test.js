import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strictToolStats } from "../api/proxy.js";

function emptyStats() {
  return {
    total: 0,
    strict: 0,
    functions: 0,
    byFormat: { chatCompletions: 0, anthropicNative: 0, responsesInline: 0, unknown: 0 },
  };
}

describe("strictToolStats", () => {
  it("returns zero stats when tools are absent", () => {
    assert.deepEqual(strictToolStats({}), emptyStats());
    assert.deepEqual(strictToolStats({ tools: [] }), emptyStats());
  });

  it("counts OpenAI Chat Completions strict tools", () => {
    const stats = strictToolStats({
      tools: [
        { type: "function", function: { name: "a", strict: true, parameters: {} } },
        { type: "function", function: { name: "b", strict: false, parameters: {} } },
        { type: "function", function: { name: "c", parameters: {} } },
      ],
    });
    assert.deepEqual(stats, {
      total: 3,
      strict: 1,
      functions: 3,
      byFormat: { chatCompletions: 1, anthropicNative: 0, responsesInline: 0, unknown: 0 },
    });
  });

  it("counts Anthropic native strict tools", () => {
    const stats = strictToolStats({
      tools: [
        { name: "a", description: "d", strict: true, input_schema: {} },
        { name: "b", description: "d", strict: false, input_schema: {} },
        { name: "c", description: "d", input_schema: {} },
      ],
    });
    assert.deepEqual(stats, {
      total: 3,
      strict: 1,
      functions: 3,
      byFormat: { chatCompletions: 0, anthropicNative: 1, responsesInline: 0, unknown: 0 },
    });
  });

  it("counts Azure OpenAI Responses inline strict tools", () => {
    const stats = strictToolStats({
      tools: [
        { type: "function", name: "a", strict: true, parameters: {} },
        { type: "function", name: "b", strict: false, parameters: {} },
        { type: "custom", name: "apply_patch" },
      ],
    });
    assert.deepEqual(stats, {
      total: 3,
      strict: 1,
      functions: 2,
      byFormat: { chatCompletions: 0, anthropicNative: 0, responsesInline: 1, unknown: 0 },
    });
  });

  it("counts every top-level strict: true, including unknown shapes", () => {
    const stats = strictToolStats({
      tools: [
        { strict: true },
        { strict: true, input_schema: null },
        { strict: true, type: "bash_20250124" },
        { function: { strict: true } },
      ],
    });
    assert.deepEqual(stats, {
      total: 4,
      strict: 4,
      functions: 0,
      byFormat: { chatCompletions: 0, anthropicNative: 0, responsesInline: 0, unknown: 4 },
    });
  });

  it("counts malformed function strict as unknown", () => {
    const stats = strictToolStats({
      tools: [
        { function: { strict: true } },
        { type: "not_function", function: { strict: true } },
      ],
    });
    assert.deepEqual(stats, {
      total: 2,
      strict: 2,
      functions: 0,
      byFormat: { chatCompletions: 0, anthropicNative: 0, responsesInline: 0, unknown: 2 },
    });
  });

  it("counts multiple strict tools across recognized formats", () => {
    const stats = strictToolStats({
      tools: [
        { type: "function", function: { strict: true } },
        { name: "x", strict: true, input_schema: {} },
        { type: "function", name: "y", strict: true },
      ],
    });
    assert.deepEqual(stats, {
      total: 3,
      strict: 3,
      functions: 3,
      byFormat: { chatCompletions: 1, anthropicNative: 1, responsesInline: 1, unknown: 0 },
    });
  });

  it("does not mutate the input body", () => {
    const tools = [
      { type: "function", function: { name: "a", strict: true, parameters: {} } },
    ];
    const body = { tools };
    const before = JSON.stringify(body);
    strictToolStats(body);
    assert.equal(JSON.stringify(body), before);
  });
});
