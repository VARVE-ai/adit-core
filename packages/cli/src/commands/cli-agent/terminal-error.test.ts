import { describe, expect, it } from "vitest";
import { formatCliAgentErrorForTerminal } from "./terminal-error.js";

describe("formatCliAgentErrorForTerminal", () => {
  it("formats title, status, session, and message on separate lines", () => {
    const output = formatCliAgentErrorForTerminal("adit cloud claude", {
      title: "Claude request failed",
      errorStatus: 502,
      sessionId: "abc-123",
      message: "upstream error",
    });
    expect(output).toBe(
      "\n[adit cloud claude] Claude request failed (status 502)\n" +
        "  session: abc-123\n" +
        "  upstream error\n",
    );
  });

  it("indents each line of a multi-line message", () => {
    const output = formatCliAgentErrorForTerminal("adit cloud codex", {
      message: "line one\nline two\r\nline three",
    });
    expect(output).toBe(
      "\n[adit cloud codex] error\n" +
        "  line one\n" +
        "  line two\n" +
        "  line three\n",
    );
  });

  it("falls back when payload fields are missing or invalid", () => {
    const output = formatCliAgentErrorForTerminal("adit cloud claude", {
      title: "   ",
      errorStatus: Number.NaN,
      sessionId: 42,
    });
    expect(output).toBe("\n[adit cloud claude] error\n  unknown error\n");
  });
});
