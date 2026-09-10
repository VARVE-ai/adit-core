import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnCliProcess: vi.fn(),
}));

vi.mock("../cli-process.js", () => ({
  spawnCliProcess: (...args: unknown[]) => mocks.spawnCliProcess(...args),
  killCliProcessTree: (child: { kill?: () => void } | null | undefined) => child?.kill?.(),
}));

import {
  CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE,
  CodexAppServerClient,
  CodexAppServerExitError,
  isCodexTracingLogLine,
  isRecoverableCodexAppServerToolError,
  isTransientCodexSystemSkillsError,
  normalizeCodexStderrLine,
} from "./codex-app-server-client.js";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("CodexAppServerClient", () => {
  it("waits for the app-server exit event before completing local handoff", async () => {
    const child = mockAppServerProcess();
    child.kill.mockImplementation(() => { child.killed = true; return true; });
    mocks.spawnCliProcess.mockReturnValue(child);
    const onError = vi.fn();
    const client = new CodexAppServerClient({ bin: "codex", cwd: "/tmp/project", onError });
    await client.start();
    let stopped = false;
    const stopping = client.stopAndWait().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    child.emit("exit", 0, null);
    await stopping;
    expect(stopped).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports an exit timeout and retains the child so local handoff can be retried", async () => {
    vi.useFakeTimers();
    const child = mockAppServerProcess();
    child.kill.mockImplementation(() => { child.killed = true; return true; });
    mocks.spawnCliProcess.mockReturnValue(child);
    const client = new CodexAppServerClient({ bin: "codex", cwd: "/tmp/project" });
    try {
      await client.start();
      const rejected = expect(client.stopAndWait()).rejects.toThrow("did not exit");
      await vi.advanceTimersByTimeAsync(1500);
      await rejected;
      const stopping = client.stopAndWait();
      child.emit("exit", 0, null);
      await stopping;
    } finally {
      client.stop();
      vi.useRealTimers();
    }
  });

  it("starts app-server with request_user_input enabled for Default mode", async () => {
    mocks.spawnCliProcess.mockReturnValue(mockAppServerProcess());
    const client = new CodexAppServerClient({ bin: "codex", cwd: "/tmp/project" });

    await client.start();

    expect(mocks.spawnCliProcess).toHaveBeenCalledWith(
      "codex",
      [
        "app-server",
        "--enable",
        CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE,
        "--listen",
        "stdio://",
      ],
      expect.objectContaining({
        cwd: "/tmp/project",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  });

  it("defers transient system skills ENOENT stderr until explicitly flushed", async () => {
    const child = mockAppServerProcess();
    mocks.spawnCliProcess.mockReturnValue(child);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = new CodexAppServerClient({ bin: "codex", cwd: "/tmp/project" });
    await client.start();

    child.stderr.emit(
      "data",
      "2026 ERROR codex_core_skills::loader: failed to stat skills path /Users/edy/.codex/skills/.system/imagegen/SKILL.md: No such file or directory (os error 2)\n",
    );

    expect(client.hasDeferredSystemSkillsStderr()).toBe(true);
    expect(stderrWrite).not.toHaveBeenCalled();

    client.flushDeferredSystemSkillsStderr();

    expect(client.hasDeferredSystemSkillsStderr()).toBe(false);
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("[codex app-server] 2026 ERROR codex_core_skills::loader"),
    );
  });

  it("prints non-system-skills stderr immediately", async () => {
    const child = mockAppServerProcess();
    mocks.spawnCliProcess.mockReturnValue(child);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = new CodexAppServerClient({ bin: "codex", cwd: "/tmp/project" });
    await client.start();

    child.stderr.emit("data", "regular app-server warning\n");

    expect(client.hasDeferredSystemSkillsStderr()).toBe(false);
    expect(stderrWrite).toHaveBeenCalledWith("[codex app-server] regular app-server warning\n");
  });

  it("suppresses known recoverable write_stdin stderr unless debug logging is enabled", async () => {
    const child = mockAppServerProcess();
    mocks.spawnCliProcess.mockReturnValue(child);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = new CodexAppServerClient({ bin: "codex", cwd: "/tmp/project" });
    await client.start();

    child.stderr.emit(
      "data",
      "2026 ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open\n",
    );

    expect(stderrWrite).not.toHaveBeenCalled();

    process.env.ADIT_DEBUG = "1";
    child.stderr.emit(
      "data",
      "2026 ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open\n",
    );

    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("[codex app-server] 2026 ERROR codex_core::tools::router"),
    );
  });

  it("buffers structured tracing diagnostics instead of printing them", async () => {
    const child = mockAppServerProcess();
    mocks.spawnCliProcess.mockReturnValue(child);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = new CodexAppServerClient({ bin: "codex", cwd: "/tmp/project" });
    await client.start();

    child.stderr.emit(
      "data",
      "2026-07-24T06:31:40.581553Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed\n",
    );

    expect(stderrWrite).not.toHaveBeenCalled();

    process.env.ADIT_DEBUG = "1";
    child.stderr.emit(
      "data",
      "\x1b[31m2026-07-24T06:31:45.837547Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed\x1b[0m\n",
    );

    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("[codex app-server] 2026-07-24T06:31:45.837547Z ERROR rmcp::transport::worker"),
    );
    expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining("\x1b[31m"));
  });

  it("attaches buffered diagnostics without printing them when app-server exits unexpectedly", async () => {
    const child = mockAppServerProcess();
    mocks.spawnCliProcess.mockReturnValue(child);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const onError = vi.fn();
    const client = new CodexAppServerClient({
      bin: "codex",
      cwd: "/tmp/project",
      onError,
    });
    await client.start();

    child.stderr.emit(
      "data",
      "2026-07-24T06:31:40.581553Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed\n" +
        "2026-07-24T06:31:47.782603Z ERROR codex_rmcp_client::oauth::refresh_transaction: error=failed to refresh OAuth tokens\n",
    );
    expect(stderrWrite).not.toHaveBeenCalled();

    child.emit("exit", 1, null);

    expect(stderrWrite).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(CodexAppServerExitError));
    const error = onError.mock.calls[0]?.[0] as CodexAppServerExitError;
    expect(error.message).toBe("Codex app-server exited (1)");
    expect(error.diagnostics).toEqual([
      expect.stringContaining("rmcp::transport::worker"),
      expect.stringContaining("codex_rmcp_client::oauth::refresh_transaction"),
    ]);
  });

  it("reports one failure when a child error is followed by process exit", async () => {
    const child = mockAppServerProcess();
    mocks.spawnCliProcess.mockReturnValue(child);
    const onError = vi.fn();
    const client = new CodexAppServerClient({
      bin: "codex",
      cwd: "/tmp/project",
      onError,
    });
    await client.start();

    child.emit("error", new Error("spawn pipe failed"));
    child.emit("exit", 1, null);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "spawn pipe failed" }));
  });

  it("does not dump buffered diagnostics on an intentional stop", async () => {
    const child = mockAppServerProcess();
    mocks.spawnCliProcess.mockReturnValue(child);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = new CodexAppServerClient({ bin: "codex", cwd: "/tmp/project" });
    await client.start();

    child.stderr.emit(
      "data",
      "2026-07-24T06:31:40.581553Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed\n",
    );

    client.stop();

    expect(stderrWrite).not.toHaveBeenCalled();
  });
});

describe("isTransientCodexSystemSkillsError", () => {
  it("matches system skills ENOENT loader lines only", () => {
    expect(isTransientCodexSystemSkillsError(
      "ERROR codex_core_skills::loader: failed to read skills dir /Users/edy/.codex/skills/.system/openai-docs/assets: No such file or directory (os error 2)",
    )).toBe(true);
    expect(isTransientCodexSystemSkillsError(
      "ERROR codex_core_skills::loader: failed to read skills dir /Users/edy/.codex/skills/custom: No such file or directory (os error 2)",
    )).toBe(false);
  });
});

describe("isCodexTracingLogLine", () => {
  it("matches timestamped tracing lines of any level and leaves plain output alone", () => {
    expect(isCodexTracingLogLine(
      "2026-07-24T06:31:40.581553Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed",
    )).toBe(true);
    expect(isCodexTracingLogLine(
      "2026-07-24T06:31:47.782603Z ERROR codex_rmcp_client::oauth::refresh_transaction: error=failed to refresh OAuth tokens for server cloudflare-api",
    )).toBe(true);
    expect(isCodexTracingLogLine(
      "2026-07-24T06:31:40Z WARN codex_core::config: falling back to defaults",
    )).toBe(true);
    expect(isCodexTracingLogLine(
      "\ufeff\x1b[31m2026-08-27T01:57:09.015013Z ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit\x1b[0m",
    )).toBe(true);
    expect(isCodexTracingLogLine("regular app-server warning")).toBe(false);
    expect(isCodexTracingLogLine(
      "thread 'main' panicked at src/main.rs:10: boom",
    )).toBe(false);
    expect(isCodexTracingLogLine("2026 ERROR codex_core::tools::router: error=x")).toBe(false);
  });
});

describe("normalizeCodexStderrLine", () => {
  it("removes terminal formatting and invisible prefixes before classification", () => {
    expect(normalizeCodexStderrLine(
      "loading models…\r\ufeff\x1b[31m2026 ERROR model refresh\x1b[0m\r",
    )).toBe("2026 ERROR model refresh");
  });
});

describe("isRecoverableCodexAppServerToolError", () => {
  it("matches only known recoverable write_stdin closed-session lines", () => {
    expect(isRecoverableCodexAppServerToolError(
      "ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
    )).toBe(true);
    expect(isRecoverableCodexAppServerToolError(
      "ERROR codex_core::tools::router: error=app-server crashed",
    )).toBe(false);
  });
});

function mockAppServerProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stdin: {
      writable: boolean;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter() as typeof child.stdout;
  child.stderr = new EventEmitter() as typeof child.stderr;
  child.stdout.setEncoding = vi.fn();
  child.stderr.setEncoding = vi.fn();
  child.stdin = {
    writable: true,
    write: vi.fn((payload: string) => {
      const request = JSON.parse(payload.trim()) as { id: number };
      queueMicrotask(() => {
        child.stdout.emit("data", `${JSON.stringify({ id: request.id, result: {} })}\n`);
      });
      return true;
    }),
    end: vi.fn(),
  };
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit("exit", 0, null);
    return true;
  });
  return child;
}
