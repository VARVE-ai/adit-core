import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatCliAgentErrorForTerminal,
  writeCliAgentErrorToTerminal,
} from "./terminal-error.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatCliAgentErrorForTerminal", () => {
  it("formats title, status, and message on one line without the session id", () => {
    const output = formatCliAgentErrorForTerminal("adit cloud claude", {
      title: "Claude request failed",
      errorStatus: 502,
      sessionId: "abc-123",
      message: "upstream error",
    });
    expect(output).toBe(
      "\n[adit cloud claude] Claude request failed (status 502): upstream error\n",
    );
  });

  it("collapses multi-line titles and messages", () => {
    const output = formatCliAgentErrorForTerminal("adit cloud codex", {
      title: "Codex operation\nfailed",
      message: "line one\nline two\r\n  line three",
    });
    expect(output).toBe(
      "\n[adit cloud codex] Codex operation failed: line one line two line three\n",
    );
  });

  it("falls back when payload fields are missing or invalid", () => {
    const output = formatCliAgentErrorForTerminal("adit cloud claude", {
      title: "   ",
      errorStatus: Number.NaN,
      sessionId: 42,
    });
    expect(output).toBe("\n[adit cloud claude] error: unknown error\n");
  });
});

describe("writeCliAgentErrorToTerminal", () => {
  it("sends the full session id to debug output", () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const debug = vi.fn();

    writeCliAgentErrorToTerminal(
      "adit codex",
      {
        title: "Codex operation failed",
        sessionId: "01a0473d-f373-7c60-a57b-6e49413caab2",
        message: "fetch failed",
      },
      debug,
    );

    expect(stderrWrite).toHaveBeenCalledWith(
      "\n[adit codex] Codex operation failed: fetch failed\n",
    );
    expect(debug).toHaveBeenCalledWith(
      "error session: 01a0473d-f373-7c60-a57b-6e49413caab2",
    );
  });
});
