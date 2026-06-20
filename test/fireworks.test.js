import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { providerFromModel, resolveFireworksModel } from "../lib/models.js";

describe("fireworks provider routing", () => {
  // ── providerFromModel() routing precedence ──────────────────────────

  it("routes fireworks/kimi-* to fireworks, not kimi", () => {
    assert.equal(providerFromModel("fireworks/kimi-k2p7-code"), "fireworks");
    assert.equal(providerFromModel("fireworks/kimi-k2p6"), "fireworks");
    assert.equal(providerFromModel("fireworks/kimi-k2p5"), "fireworks");
  });

  it("routes fireworks/deepseek-* to fireworks, not deepseek", () => {
    assert.equal(providerFromModel("fireworks/deepseek-v3p2"), "fireworks");
    assert.equal(providerFromModel("fireworks/deepseek-chat"), "fireworks");
    assert.equal(providerFromModel("fireworks/deepseek-v4-pro"), "fireworks");
  });

  it("routes fireworks/glm-* to fireworks, not glm", () => {
    assert.equal(providerFromModel("fireworks/glm-5p2"), "fireworks");
    assert.equal(providerFromModel("fireworks/glm-5p1"), "fireworks");
  });

  it("routes fireworks/minimax-* to fireworks, not minimax", () => {
    assert.equal(providerFromModel("fireworks/minimax-m3"), "fireworks");
  });

  it("routes fireworks/mimo-* to fireworks, not mimo", () => {
    assert.equal(providerFromModel("fireworks/mimo-v2.5-pro"), "fireworks");
  });

  // ── cursorproxy/ prefix passthrough ─────────────────────────────────

  it("routes cursorproxy/fireworks/kimi-k2p7-code to fireworks", () => {
    assert.equal(providerFromModel("cursorproxy/fireworks/kimi-k2p7-code"), "fireworks");
  });

  it("routes cursorproxy/fireworks/deepseek-v3p2 to fireworks", () => {
    assert.equal(providerFromModel("cursorproxy/fireworks/deepseek-v3p2"), "fireworks");
  });

  it("routes cursorproxy/fireworks/glm-5p2 to fireworks", () => {
    assert.equal(providerFromModel("cursorproxy/fireworks/glm-5p2"), "fireworks");
  });

  // ── No regression: existing providers still work ────────────────────

  it("routes deepseek-chat to deepseek (unchanged)", () => {
    assert.equal(providerFromModel("deepseek-chat"), "deepseek");
  });

  it("routes kimi-k2.7-code to kimi (unchanged)", () => {
    assert.equal(providerFromModel("kimi-k2.7-code"), "kimi");
  });

  it("routes glm-5.2 to glm (unchanged)", () => {
    assert.equal(providerFromModel("glm-5.2"), "glm");
  });

  it("routes minimax-m3 to minimax (unchanged)", () => {
    assert.equal(providerFromModel("minimax-m3"), "minimax");
  });

  it("routes mimo-v2.5-pro to mimo (unchanged)", () => {
    assert.equal(providerFromModel("mimo-v2.5-pro"), "mimo");
  });

  // ── resolveFireworksModel() ─────────────────────────────────────────

  it("maps fireworks/kimi-k2p7-code to accounts/fireworks/models/kimi-k2p7-code", () => {
    assert.equal(
      resolveFireworksModel("fireworks/kimi-k2p7-code"),
      "accounts/fireworks/models/kimi-k2p7-code",
    );
  });

  it("maps fireworks/deepseek-v3p2 to accounts/fireworks/models/deepseek-v3p2", () => {
    assert.equal(
      resolveFireworksModel("fireworks/deepseek-v3p2"),
      "accounts/fireworks/models/deepseek-v3p2",
    );
  });

  it("maps fireworks/glm-5p2 to accounts/fireworks/models/glm-5p2", () => {
    assert.equal(
      resolveFireworksModel("fireworks/glm-5p2"),
      "accounts/fireworks/models/glm-5p2",
    );
  });

  it("returns null for non-fireworks model", () => {
    assert.equal(resolveFireworksModel("deepseek-chat"), null);
    assert.equal(resolveFireworksModel("kimi-k2p7-code"), null);
    assert.equal(resolveFireworksModel("glm-5p2"), null);
  });

  it("returns null for empty or invalid input", () => {
    assert.equal(resolveFireworksModel(""), null);
    assert.equal(resolveFireworksModel("fireworks/"), null);
    assert.equal(resolveFireworksModel(null), null);
  });
});
