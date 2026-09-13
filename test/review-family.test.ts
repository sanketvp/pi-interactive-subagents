import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  FAMILY_TABLE,
  familyOf,
  coordinatorFamily,
  setAdditiveFamilies,
  resetAdditiveFamilies,
} from "../pi-extension/subagents/review/family.ts";

describe("family", () => {
  afterEach(() => resetAdditiveFamilies());

  it("maps known models to training families regardless of API route", () => {
    assert.equal(familyOf("anthropic/claude-fable-5-1"), "anthropic");
    assert.equal(familyOf("openrouter/anthropic/claude-fable-5-1"), "anthropic");
    assert.equal(familyOf("anthropic/claude-opus-5"), "anthropic");
    assert.equal(familyOf("anthropic/claude-sonnet-5"), "anthropic");
    assert.equal(familyOf("anthropic/claude-haiku-4-5"), "anthropic");
    assert.equal(familyOf("openai-codex/gpt-5.6-sol"), "openai");
    assert.equal(familyOf("openai-codex/gpt-5.6-luna"), "openai");
    assert.equal(familyOf("openai-codex/gpt-5.6-terra"), "openai");
    assert.equal(familyOf("openai-codex/gpt-6-astra"), "openai");
    assert.equal(familyOf("xai/grok-4.6"), "xai");
    assert.equal(familyOf("kimi-coding/k3"), "moonshot");
    assert.equal(familyOf("moonshot/kimi-k2"), "moonshot");
    assert.equal(familyOf("openrouter/z-ai/glm-5.3"), "zai");
    assert.equal(familyOf("openrouter/z-ai/glm-5.3-flash"), "zai");
  });

  it("unknown model → family unknown (fail closed)", () => {
    assert.equal(familyOf("mystery-model"), "unknown");
    assert.equal(familyOf(""), "unknown");
    assert.equal(familyOf(null), "unknown");
    assert.equal(familyOf({ id: "not-a-real-model" }), "unknown");
  });

  it("coordinatorFamily re-reads ctx.model every call (never cached)", () => {
    const ctx: { model: string } = { model: "anthropic/claude-opus-5" };
    assert.equal(coordinatorFamily(ctx), "anthropic");
    ctx.model = "xai/grok-4.6";
    assert.equal(coordinatorFamily(ctx), "xai");
    ctx.model = "totally-unknown";
    assert.equal(coordinatorFamily(ctx), "unknown");
  });

  it("families.json is additive; built-in FAMILY_TABLE wins", () => {
    assert.ok(FAMILY_TABLE.length >= 5);
    setAdditiveFamilies({ "custom-build-engine": "xai", "claude-opus-5": "zai" });
    assert.equal(familyOf("custom-build-engine"), "xai");
    // cannot remap a known Anthropic model
    assert.equal(familyOf("anthropic/claude-opus-5"), "anthropic");
  });

  it("per-call extra additive does not persist", () => {
    assert.equal(familyOf("one-off-model", { "one-off-model": "moonshot" }), "moonshot");
    assert.equal(familyOf("one-off-model"), "unknown");
  });

  it("prototype-pollution model ids fail closed as unknown", () => {
    for (const name of ["constructor", "toString", "__proto__", "valueOf"]) {
      assert.equal(familyOf(name), "unknown");
    }
  });
});
