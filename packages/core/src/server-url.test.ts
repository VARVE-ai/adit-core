import { describe, expect, it } from "vitest";
import { normalizeServerUrl } from "./server-url.js";

describe("normalizeServerUrl", () => {
  it("trims whitespace and trailing slashes", () => {
    expect(normalizeServerUrl("  http://localhost:3000///  ")).toBe(
      "http://localhost:3000",
    );
  });

  it("does not merge different host spellings", () => {
    expect(normalizeServerUrl("http://localhost:3000")).not.toBe(
      normalizeServerUrl("http://127.0.0.1:3000"),
    );
  });
});
