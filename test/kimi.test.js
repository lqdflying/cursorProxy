import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeKimiBody } from "../lib/kimi.js";

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
