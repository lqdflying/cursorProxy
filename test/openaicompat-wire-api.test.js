import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  openaiCompatWireApi,
  isOpenAICompatResponses,
  _resetOpenaicompatWireApiWarningForTests,
} from "../lib/models.js";

describe("openaiCompatWireApi", () => {
  const orig = process.env.OPENAICOMPAT_WIRE_API;

  afterEach(() => {
    if (orig === undefined) {
      delete process.env.OPENAICOMPAT_WIRE_API;
    } else {
      process.env.OPENAICOMPAT_WIRE_API = orig;
    }
  });

  it("returns 'chat' by default when env var is unset", () => {
    delete process.env.OPENAICOMPAT_WIRE_API;
    assert.equal(openaiCompatWireApi(), "chat");
  });

  it("returns 'responses' when OPENAICOMPAT_WIRE_API=responses", () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    assert.equal(openaiCompatWireApi(), "responses");
  });

  it("returns 'chat' when OPENAICOMPAT_WIRE_API=chat", () => {
    process.env.OPENAICOMPAT_WIRE_API = "chat";
    assert.equal(openaiCompatWireApi(), "chat");
  });

  it("falls back to 'chat' for invalid values", () => {
    for (const v of ["bogus", "", "true", "1", "  ", "responses2", "xml"]) {
      process.env.OPENAICOMPAT_WIRE_API = v;
      assert.equal(openaiCompatWireApi(), "chat", `value "${v}" should fall back to chat`);
    }
  });

  it("accepts case-insensitive 'responses' variants", () => {
    for (const v of ["RESPONSES", "Responses", "responses"]) {
      process.env.OPENAICOMPAT_WIRE_API = v;
      assert.equal(openaiCompatWireApi(), "responses", `value "${v}" should be accepted`);
    }
  });

  it("trims and lowercases the value", () => {
    process.env.OPENAICOMPAT_WIRE_API = "  Responses  ";
    assert.equal(openaiCompatWireApi(), "responses");
  });
});

describe("isOpenAICompatResponses", () => {
  const orig = process.env.OPENAICOMPAT_WIRE_API;

  afterEach(() => {
    if (orig === undefined) {
      delete process.env.OPENAICOMPAT_WIRE_API;
    } else {
      process.env.OPENAICOMPAT_WIRE_API = orig;
    }
  });

  it("returns true only for openaicompat + responses mode", () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    assert.equal(isOpenAICompatResponses("openaicompat"), true);
  });

  it("returns false for openaicompat in chat mode", () => {
    process.env.OPENAICOMPAT_WIRE_API = "chat";
    assert.equal(isOpenAICompatResponses("openaicompat"), false);
  });

  it("returns false for openaicompat when env var is unset", () => {
    delete process.env.OPENAICOMPAT_WIRE_API;
    assert.equal(isOpenAICompatResponses("openaicompat"), false);
  });

  it("returns false for other providers even in responses mode", () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    for (const pk of ["azureopenai", "deepseek", "kimi", "minimax", "mimo", "glm", "fireworks", "azureanthropic", "anthropiccompat"]) {
      assert.equal(isOpenAICompatResponses(pk), false, `provider "${pk}" must not match`);
    }
  });

  it("returns false for null/undefined/empty provider keys", () => {
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    assert.equal(isOpenAICompatResponses(null), false);
    assert.equal(isOpenAICompatResponses(undefined), false);
    assert.equal(isOpenAICompatResponses(""), false);
  });
});

describe("openaiCompatWireApi invalid-value warning", () => {
  const orig = process.env.OPENAICOMPAT_WIRE_API;
  const origWarn = console.warn;
  let warnCalls = [];

  afterEach(() => {
    if (orig === undefined) {
      delete process.env.OPENAICOMPAT_WIRE_API;
    } else {
      process.env.OPENAICOMPAT_WIRE_API = orig;
    }
    console.warn = origWarn;
  });

  it("emits a one-time warning for an invalid value, then stays silent", () => {
    _resetOpenaicompatWireApiWarningForTests();
    warnCalls = [];
    console.warn = (msg) => { warnCalls.push(String(msg)); };

    // First call with an invalid value → warns once.
    process.env.OPENAICOMPAT_WIRE_API = "responces"; // typo
    assert.equal(openaiCompatWireApi(), "chat");
    const firstPass = warnCalls.filter((m) => m.includes("OPENAICOMPAT_WIRE_API_INVALID"));
    assert.equal(firstPass.length, 1, `expected one warning, got ${firstPass.length}`);

    // Subsequent invalid calls → no additional warning (once-per-process).
    process.env.OPENAICOMPAT_WIRE_API = "bogus";
    assert.equal(openaiCompatWireApi(), "chat");
    const secondPass = warnCalls.filter((m) => m.includes("OPENAICOMPAT_WIRE_API_INVALID"));
    assert.equal(secondPass.length, 1, `warning should not repeat (once-per-process), got ${secondPass.length}`);
  });

  it("does NOT warn for valid 'chat' or 'responses' values", () => {
    _resetOpenaicompatWireApiWarningForTests();
    warnCalls = [];
    console.warn = (msg) => { warnCalls.push(String(msg)); };

    process.env.OPENAICOMPAT_WIRE_API = "chat";
    openaiCompatWireApi();
    process.env.OPENAICOMPAT_WIRE_API = "responses";
    openaiCompatWireApi();

    const invalidWarnings = warnCalls.filter((m) => m.includes("OPENAICOMPAT_WIRE_API_INVALID"));
    assert.equal(invalidWarnings.length, 0, `valid values must not warn, got ${invalidWarnings.length}`);
  });
});
