import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeLocalSessionLister,
  CodexLocalSessionLister,
  LocalSessionsReporter,
} from "./local-sessions.js";

const CWD = "/tmp/project";

function claudeProjectDir(configDir: string): string {
  const projectId = path.resolve(CWD).replace(/[^a-zA-Z0-9-]/g, "-");
  return path.join(configDir, "projects", projectId);
}

function writeClaudeTranscript(configDir: string, sessionId: string, valid = true): string {
  const dir = claudeProjectDir(configDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const line = valid
    ? JSON.stringify({ sessionId, type: "user", uuid: `u-${sessionId}` })
    : JSON.stringify({ sessionId, type: "summary" });
  fs.writeFileSync(file, `${line}\n`);
  return file;
}

describe("ClaudeLocalSessionLister", () => {
  let configDir: string;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(tmpdir(), "adit-local-sessions-"));
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("lists only valid uuid transcripts for the project", () => {
    const validId = "11111111-1111-1111-1111-111111111111";
    const invalidId = "22222222-2222-2222-2222-222222222222";
    writeClaudeTranscript(configDir, validId);
    writeClaudeTranscript(configDir, invalidId, false);
    fs.writeFileSync(path.join(claudeProjectDir(configDir), "not-a-uuid.jsonl"), "{}\n");

    const lister = new ClaudeLocalSessionLister(CWD);
    expect(lister.list()).toEqual([validId]);
  });

  it("returns an empty list when the project directory is missing", () => {
    const lister = new ClaudeLocalSessionLister(CWD);
    expect(lister.list()).toEqual([]);
  });

  it("revalidates a transcript when its file changes", () => {
    const sessionId = "33333333-3333-3333-3333-333333333333";
    const file = writeClaudeTranscript(configDir, sessionId, false);
    const lister = new ClaudeLocalSessionLister(CWD);
    expect(lister.list()).toEqual([]);

    fs.writeFileSync(
      file,
      `${JSON.stringify({ sessionId, type: "user", uuid: `u-${sessionId}` })}\n`,
    );
    fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(lister.list()).toEqual([sessionId]);
  });

  it("drops sessions whose transcripts were deleted", () => {
    const sessionId = "44444444-4444-4444-4444-444444444444";
    const file = writeClaudeTranscript(configDir, sessionId);
    const lister = new ClaudeLocalSessionLister(CWD);
    expect(lister.list()).toEqual([sessionId]);

    fs.rmSync(file);
    expect(lister.list()).toEqual([]);
  });
});

function writeCodexRollout(input: {
  codexHome: string;
  threadId: string;
  cwd?: string;
  archived?: boolean;
  omitMeta?: boolean;
}): string {
  const dir = path.join(
    input.codexHome,
    input.archived ? "archived_sessions" : "sessions",
    "2026",
    "07",
    "08",
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-07-08T10-00-00-${input.threadId}.jsonl`);
  const meta = input.omitMeta
    ? JSON.stringify({ type: "other" })
    : JSON.stringify({
        timestamp: "2026-07-08T10:00:00.000Z",
        type: "session_meta",
        payload: { id: input.threadId, cwd: input.cwd ?? CWD },
      });
  fs.writeFileSync(file, `${meta}\n`);
  return file;
}

describe("CodexLocalSessionLister", () => {
  let codexHome: string;
  const originalCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(tmpdir(), "adit-codex-home-"));
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  it("lists project rollouts including archived ones", () => {
    const activeId = "019e0000-0000-7000-8000-000000000001";
    const archivedId = "019e0000-0000-7000-8000-000000000002";
    writeCodexRollout({ codexHome, threadId: activeId });
    writeCodexRollout({ codexHome, threadId: archivedId, archived: true });

    const lister = new CodexLocalSessionLister(CWD);
    expect(new Set(lister.list())).toEqual(new Set([activeId, archivedId]));
  });

  it("filters out rollouts from other projects", () => {
    const projectId = "019e0000-0000-7000-8000-000000000003";
    const otherId = "019e0000-0000-7000-8000-000000000004";
    const subdirId = "019e0000-0000-7000-8000-000000000005";
    writeCodexRollout({ codexHome, threadId: projectId });
    writeCodexRollout({ codexHome, threadId: otherId, cwd: "/tmp/other-project" });
    writeCodexRollout({ codexHome, threadId: subdirId, cwd: `${CWD}/packages/app` });

    const lister = new CodexLocalSessionLister(CWD);
    expect(new Set(lister.list())).toEqual(new Set([projectId, subdirId]));
  });

  it("includes rollouts whose metadata cannot be read", () => {
    const threadId = "019e0000-0000-7000-8000-000000000006";
    writeCodexRollout({ codexHome, threadId, omitMeta: true });

    const lister = new CodexLocalSessionLister(CWD);
    expect(lister.list()).toEqual([threadId]);
  });

  it("drops threads whose rollouts were deleted", () => {
    const threadId = "019e0000-0000-7000-8000-000000000007";
    const file = writeCodexRollout({ codexHome, threadId });
    const lister = new CodexLocalSessionLister(CWD);
    expect(lister.list()).toEqual([threadId]);

    fs.rmSync(file);
    expect(lister.list()).toEqual([]);
  });
});

interface FakeWs {
  isOpen: boolean;
  currentConnectionId: string | null;
  sendLocalSessions: ReturnType<typeof vi.fn>;
}

function fakeWs(): FakeWs {
  return {
    isOpen: true,
    currentConnectionId: "conn-1",
    sendLocalSessions: vi.fn(() => true),
  };
}

describe("LocalSessionsReporter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports on the first connected iteration and then throttles", () => {
    const ws = fakeWs();
    const reporter = new LocalSessionsReporter(
      ws as never,
      () => ["a", "b"],
      30_000,
    );

    reporter.maybeReport();
    reporter.maybeReport();
    expect(ws.sendLocalSessions).toHaveBeenCalledTimes(1);
    expect(ws.sendLocalSessions).toHaveBeenCalledWith(["a", "b"]);

    vi.advanceTimersByTime(31_000);
    reporter.maybeReport();
    // Unchanged list — throttle window refreshed without a resend.
    expect(ws.sendLocalSessions).toHaveBeenCalledTimes(1);
  });

  it("resends when the list changes after the interval", () => {
    const ws = fakeWs();
    let ids = ["a"];
    const reporter = new LocalSessionsReporter(ws as never, () => ids, 30_000);

    reporter.maybeReport();
    ids = ["a", "b"];
    vi.advanceTimersByTime(31_000);
    reporter.maybeReport();

    expect(ws.sendLocalSessions).toHaveBeenCalledTimes(2);
    expect(ws.sendLocalSessions).toHaveBeenLastCalledWith(["a", "b"]);
  });

  it("forces a report after commands were processed", () => {
    const ws = fakeWs();
    let ids = ["a"];
    const reporter = new LocalSessionsReporter(ws as never, () => ids, 30_000);

    reporter.maybeReport();
    ids = ["a", "b"];
    reporter.maybeReport(true);

    expect(ws.sendLocalSessions).toHaveBeenCalledTimes(2);
    expect(ws.sendLocalSessions).toHaveBeenLastCalledWith(["a", "b"]);
  });

  it("resends the list to a new connection after reconnect", () => {
    const ws = fakeWs();
    const reporter = new LocalSessionsReporter(ws as never, () => ["a"], 30_000);

    reporter.maybeReport();
    ws.currentConnectionId = "conn-2";
    reporter.maybeReport();

    expect(ws.sendLocalSessions).toHaveBeenCalledTimes(2);
  });

  it("does not report while disconnected", () => {
    const ws = fakeWs();
    ws.isOpen = false;
    const reporter = new LocalSessionsReporter(ws as never, () => ["a"], 30_000);

    reporter.maybeReport();
    expect(ws.sendLocalSessions).not.toHaveBeenCalled();
  });
});
