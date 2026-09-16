import { describe, it, expect } from "vitest";
import { normalizeUsage, sanitizeUsage } from "./usage.js";

describe("token usage normalization", () => {
  it("includes Claude cache components exactly once", () => {
    const usage = normalizeUsage("claude", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 30, cache_creation_input_tokens: 20 });
    expect(usage.inputTokens).toBe(60);
    expect(usage.totalTokens).toBe(65);
  });
  it("does not add Codex cache and reasoning subsets again", () => {
    const usage = normalizeUsage("codex", { input_tokens: 100, output_tokens: 20, cached_input_tokens: 80, reasoning_output_tokens: 15 });
    expect(usage.totalTokens).toBe(120);
  });
  it("preserves missing values and explicit zero", () => {
    expect(normalizeUsage("claude", { input_tokens: 10, output_tokens: 0 }).totalTokens).toBeNull();
    expect(normalizeUsage("codex", { input_tokens: 0, output_tokens: 0 }).totalTokens).toBe(0);
    expect(normalizeUsage("codex", {}).totalTokens).toBeNull();
  });
  it("drops unknown fields and invalid counts", () => {
    expect(sanitizeUsage({ api_key: "secret", input_tokens: -1, output_tokens: 1.5, total_tokens: Infinity })).toEqual({});
    expect(normalizeUsage("codex", { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }).totalTokens).toBeNull();
    expect(normalizeUsage("codex", { input_tokens: 10, output_tokens: 5, total_tokens: 14 }).totalTokens).toBeNull();
  });
});
