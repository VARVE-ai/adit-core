import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudAuthError } from "@varveai/adit-cloud";
import {
  createRelayNotices,
  createRelayStatusReporter,
  describeRelayError,
  formatTerminalNotice,
  type RelayNotices,
} from "./relay-console.js";

function makeNotices(overrides: {
  debugEnabled?: boolean;
  isTTY?: boolean;
  tool?: "claude" | "codex";
} = {}): { notices: RelayNotices; output: string[]; restoreTerminal: ReturnType<typeof vi.fn> } {
  const output: string[] = [];
  const restoreTerminal = vi.fn();
  const notices = createRelayNotices(overrides.tool ?? "claude", {
    write: (text) => void output.push(text),
    isTTY: () => overrides.isTTY ?? false,
    debugEnabled: () => overrides.debugEnabled ?? false,
    restoreTerminal,
  });
  return { notices, output, restoreTerminal };
}

describe("formatTerminalNotice", () => {
  it("clears stale TUI content when writing notices to a TTY", () => {
    expect(formatTerminalNotice("[adit codex] taken over", true)).toBe(
      "\r\x1b[2K\r\n\r\x1b[2K[adit codex] taken over\x1b[0K\r\n\r\x1b[2K",
    );
  });

  it("keeps plain newlines for non-TTY output", () => {
    expect(formatTerminalNotice("[adit codex] taken over\n", false)).toBe(
      "\n[adit codex] taken over\n",
    );
  });
});

describe("createRelayNotices", () => {
  it("prefixes plain lines with the tool tag", () => {
    const { notices, output } = makeNotices();
    notices.line("Connected demo → adit-cloud Coding");
    expect(output).toEqual(["[adit claude] Connected demo → adit-cloud Coding\n"]);
  });

  it("suppresses debug lines unless debug is enabled", () => {
    const quiet = makeNotices();
    quiet.notices.debug("terminal abc");
    expect(quiet.output).toEqual([]);

    const verbose = makeNotices({ debugEnabled: true });
    verbose.notices.debug("terminal abc");
    expect(verbose.output).toEqual(["[adit claude] debug: terminal abc\n"]);
  });

  it("announces takeover start and failure with the tool subject", () => {
    const codex = makeNotices({ tool: "codex" });
    codex.notices.takeoverStarted();
    codex.notices.takeoverFailed();
    expect(codex.output).toEqual([
      "\n[adit codex] Web is taking over this session — local Codex will hand off shortly…\n",
      "\n[adit codex] Web takeover failed — local Codex keeps control.\n",
    ]);
  });

  it("resets the terminal and uses one reclaim phrasing on takeover", () => {
    const { notices, output, restoreTerminal } = makeNotices({ tool: "codex" });
    notices.takenOverByWeb();
    notices.webOwnsReminder();
    expect(restoreTerminal).toHaveBeenCalledTimes(1);
    expect(output).toEqual([
      "\n[adit codex] Web has taken over this session — type /local + Enter here to reclaim.\n",
      "\n[adit codex] Web owns this session — type /local + Enter here to reclaim.\n",
    ]);
  });

  it("names the local subject when releasing web control", () => {
    const claude = makeNotices();
    claude.notices.releasingToLocal();
    expect(claude.output).toEqual([
      "\n[adit claude] Releasing web control — restarting local Claude Code…\n",
    ]);

    const codex = makeNotices({ tool: "codex" });
    codex.notices.releasingToLocal();
    expect(codex.output).toEqual([
      "\n[adit codex] Releasing web control — restarting local Codex…\n",
    ]);
  });

  it("formats shutdown notices", () => {
    const { notices, output } = makeNotices();
    notices.shutdown("SIGINT");
    expect(output).toEqual(["\n[adit claude] Received SIGINT — shutting down.\n"]);
  });

  it("classifies typed cloud errors", () => {
    const { notices, output } = makeNotices();
    notices.cloudError("relay loop", new CloudAuthError("token expired"));
    expect(output).toEqual([
      "[adit claude] relay loop: authentication failed. Run 'adit cloud login' again.\n",
      "token expired\n",
    ]);
  });

  it("prints plain errors on a single line", () => {
    const { notices, output } = makeNotices();
    notices.cloudError("relay loop", new Error("boom"));
    expect(output).toEqual(["[adit claude] relay loop: boom\n"]);
  });
});

describe("describeRelayError", () => {
  it("summarizes auth failures with the recovery command", () => {
    expect(describeRelayError(new CloudAuthError("expired"))).toBe(
      "authentication failed — run 'adit cloud login' again",
    );
  });

  it("falls back to the error message", () => {
    expect(describeRelayError(new Error("connect ECONNREFUSED 127.0.0.1:3001"))).toBe(
      "connect ECONNREFUSED 127.0.0.1:3001",
    );
    expect(describeRelayError("boom")).toBe("boom");
  });
});

describe("createRelayStatusReporter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeReporter(opts: { debugEnabled?: boolean } = {}) {
    const { notices, output } = makeNotices({ debugEnabled: opts.debugEnabled ?? false });
    const reporter = createRelayStatusReporter({
      notices,
      projectName: "test-coding2",
      projectRoot: "/tmp/test-coding2",
      terminalId: "terminal-1",
      serverUrl: "http://localhost:3000",
      unreachableDelayMs: 10_000,
    });
    return { reporter, output };
  }

  const hello = (owner: "local" | "web" | "stopped" = "local") => ({
    connectionId: "conn-1",
    panelId: "panel-1",
    panelName: "test-coding2",
    owner,
  });

  it("prints the banner once on the first hello", () => {
    const { reporter, output } = makeReporter();
    reporter.helloOk(hello());
    expect(output).toEqual([
      "[adit claude] Connected test-coding2 → adit-cloud Coding\n",
      "[adit claude] Local Claude Code owns this session — if the web page takes over, " +
        "type /local + Enter here to reclaim.\n",
    ]);

    output.length = 0;
    reporter.helloOk(hello());
    expect(output).toEqual([]);
  });

  it("moves connection details to debug lines", () => {
    const { reporter, output } = makeReporter({ debugEnabled: true });
    reporter.helloOk(hello());
    expect(output).toContain("[adit claude] debug: project /tmp/test-coding2\n");
    expect(output).toContain("[adit claude] debug: server http://localhost:3000\n");
    expect(output).toContain("[adit claude] debug: terminal terminal-1\n");
    expect(output).toContain("[adit claude] debug: connection conn-1\n");
    expect(output).toContain("[adit claude] debug: panel test-coding2 (panel-1)\n");
  });

  it("stays silent through quick reconnect flaps", () => {
    const { reporter, output } = makeReporter();
    reporter.helloOk(hello());
    output.length = 0;

    for (let round = 0; round < 5; round++) {
      reporter.relayError(new Error("connect ECONNREFUSED 127.0.0.1:3001"));
      vi.advanceTimersByTime(3_000);
      reporter.helloOk(hello());
    }
    expect(output).toEqual([]);
  });

  it("reports a sustained outage once and dedupes repeated errors", () => {
    const { reporter, output } = makeReporter();
    reporter.helloOk(hello());
    output.length = 0;

    reporter.relayError(new Error("connect ECONNREFUSED 127.0.0.1:3001"));
    vi.advanceTimersByTime(9_999);
    expect(output).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(output).toEqual([
      "\n[adit claude] Cloud relay unreachable (connect ECONNREFUSED 127.0.0.1:3001) " +
        "— retrying in background…\n",
    ]);

    output.length = 0;
    reporter.relayError(new Error("connect ECONNREFUSED 127.0.0.1:3001"));
    reporter.relayError(new Error("connect ECONNREFUSED 127.0.0.1:3001"));
    expect(output).toEqual([]);

    reporter.relayError(new CloudAuthError("expired"));
    expect(output).toEqual([
      "\n[adit claude] Cloud relay unreachable (authentication failed — run 'adit cloud login' " +
        "again) — retrying in background…\n",
    ]);
  });

  it("announces recovery only after a visible outage", () => {
    const { reporter, output } = makeReporter();
    reporter.helloOk(hello());
    reporter.relayError(new Error("connect ECONNREFUSED 127.0.0.1:3001"));
    vi.advanceTimersByTime(10_000);
    output.length = 0;

    reporter.helloOk(hello("local"));
    expect(output).toEqual(["\n[adit claude] Cloud relay reconnected.\n"]);

    output.length = 0;
    reporter.relayError(new Error("connect ECONNREFUSED 127.0.0.1:3001"));
    vi.advanceTimersByTime(10_000);
    output.length = 0;
    reporter.helloOk(hello("web"));
    expect(output).toEqual([
      "\n[adit claude] Cloud relay reconnected — web still owns this session.\n",
    ]);
  });

  it("logs retry scheduling as debug output", () => {
    const { reporter, output } = makeReporter({ debugEnabled: true });
    reporter.relayError(new Error("connect ECONNREFUSED 127.0.0.1:3001"));
    output.length = 0;
    reporter.retryScheduled(3, 4_000);
    expect(output).toEqual([
      "[adit claude] debug: ws retry #3 in 4s: connect ECONNREFUSED 127.0.0.1:3001\n",
    ]);
  });
});
