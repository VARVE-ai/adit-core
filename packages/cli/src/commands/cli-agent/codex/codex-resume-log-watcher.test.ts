import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import {
  isCodexThreadSavedForCwd,
  readCodexResumeLogEvents,
  startCodexResumeLogWatcher,
} from "./codex-resume-log-watcher.js";

function tempDir(): string {
  const dir = join(tmpdir(), `adit-codex-resume-log-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function setupCodexDatabases(codexHome: string): void {
  const logs = new Database(join(codexHome, "logs_2.sqlite"));
  logs.exec(`
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL DEFAULT 0,
      ts_nanos INTEGER NOT NULL DEFAULT 0,
      level TEXT NOT NULL DEFAULT 'TRACE',
      target TEXT NOT NULL DEFAULT 'log',
      feedback_log_body TEXT,
      thread_id TEXT,
      process_uuid TEXT
    );
  `);
  logs.close();

  const state = new Database(join(codexHome, "state_5.sqlite"));
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL
    );
  `);
  state.close();
}

function insertThread(codexHome: string, id: string, cwd: string): void {
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.prepare("INSERT INTO threads (id, cwd) VALUES (?, ?)").run(id, cwd);
  db.close();
}

function insertLog(
  codexHome: string,
  threadId: string | null,
  body: string,
  processUuid = "pid:100:default",
): number {
  const db = new Database(join(codexHome, "logs_2.sqlite"));
  const result = db.prepare(`
    INSERT INTO logs (feedback_log_body, thread_id, process_uuid)
    VALUES (?, ?, ?)
  `).run(body, threadId, processUuid);
  db.close();
  return Number(result.lastInsertRowid);
}

describe("readCodexResumeLogEvents", () => {
  it("detects resume before hooks and ignores another terminal in the same project", async () => {
    const codexHome = tempDir();
    let watcher: ReturnType<typeof startCodexResumeLogWatcher> | undefined;
    try {
      setupCodexDatabases(codexHome);
      insertThread(codexHome, "thread-other", "/tmp/project");
      insertThread(codexHome, "thread-local", "/tmp/project");
      const marker = 'otel.name="thread/resume" app_server.client_name="codex-tui"';
      insertLog(codexHome, "thread-other", marker, "pid:101:other");
      insertLog(codexHome, "thread-local", marker, "pid:202:local");
      const resumed: string[] = [];
      watcher = startCodexResumeLogWatcher({
        codexHome, cwd: "/tmp/project", processId: 202, afterLogId: 0,
        pollIntervalMs: 5, onResume: (id) => resumed.push(id),
      });
      await vi.waitFor(() => expect(resumed).toEqual(["thread-local"]));
      insertLog(codexHome, "thread-other", marker, "pid:101:other");
      insertLog(codexHome, "thread-local", marker, "pid:202:local");
      await vi.waitFor(() => expect(resumed).toEqual(["thread-local", "thread-local"]));
    } finally {
      watcher?.stop();
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("finds the native writer beneath a launcher without a prompt hook", async () => {
    const codexHome = tempDir();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      windowsHide: true, stdio: "ignore",
    });
    let watcher: ReturnType<typeof startCodexResumeLogWatcher> | undefined;
    try {
      setupCodexDatabases(codexHome);
      insertThread(codexHome, "thread-child", "/tmp/project");
      insertLog(codexHome, "thread-child",
        'otel.name="thread/resume" app_server.client_name="codex-tui"', `pid:${child.pid}:child`);
      const resumed: string[] = [];
      watcher = startCodexResumeLogWatcher({
        codexHome, cwd: "/tmp/project", processId: process.pid, afterLogId: 0,
        pollIntervalMs: 10, onResume: (id) => resumed.push(id),
      });
      await vi.waitFor(() => expect(resumed).toEqual(["thread-child"]), { timeout: 8000 });
    } finally {
      watcher?.stop();
      const exited = once(child, "exit");
      child.kill();
      await exited;
      rmSync(codexHome, { recursive: true, force: true });
    }
  }, 10000);

  it("does not report a resume after the watcher has stopped", async () => {
    const codexHome = tempDir();
    try {
      setupCodexDatabases(codexHome);
      insertThread(codexHome, "thread-local", "/tmp/project");
      insertLog(codexHome, "thread-local",
        'otel.name="thread/resume" app_server.client_name="codex-tui"', "pid:202:local");
      const resumed: string[] = [];
      const watcher = startCodexResumeLogWatcher({
        codexHome, cwd: "/tmp/project", processId: 202, afterLogId: 0,
        onResume: (id) => resumed.push(id),
      });
      watcher.stop();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(resumed).toEqual([]);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("returns only Codex TUI resume events for the current project cwd", () => {
    const codexHome = tempDir();
    try {
      setupCodexDatabases(codexHome);
      insertThread(codexHome, "thread-current", "/tmp/project");
      insertThread(codexHome, "thread-other", "/tmp/other");

      insertLog(codexHome, "thread-current", "app_server.request otel.name=\"thread/start\" app_server.client_name=\"codex-tui\"");
      insertLog(codexHome, "thread-other", "app_server.request otel.name=\"thread/resume\" app_server.client_name=\"codex-tui\"");
      const expectedId = insertLog(codexHome, "thread-current", "app_server.request otel.name=\"thread/resume\" app_server.client_name=\"codex-tui\"");
      insertLog(codexHome, "thread-current", "app_server.request otel.name=\"thread/resume\" app_server.client_name=\"other-client\"");

      const result = readCodexResumeLogEvents({
        codexHome,
        cwd: "/tmp/project",
        afterLogId: 0,
      });

      expect(result.threadIds).toEqual(["thread-current"]);
      expect(result.lastLogId).toBeGreaterThanOrEqual(expectedId);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("ignores resume events already behind the log watermark", () => {
    const codexHome = tempDir();
    try {
      setupCodexDatabases(codexHome);
      insertThread(codexHome, "thread-current", "/tmp/project");
      const logId = insertLog(codexHome, "thread-current", "app_server.request otel.name=\"thread/resume\" app_server.client_name=\"codex-tui\"");

      const result = readCodexResumeLogEvents({
        codexHome,
        cwd: "/tmp/project",
        afterLogId: logId,
      });

      expect(result.threadIds).toEqual([]);
      expect(result.lastLogId).toBe(logId);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("filters same-project resume events by Codex process uuid", () => {
    const codexHome = tempDir();
    try {
      setupCodexDatabases(codexHome);
      insertThread(codexHome, "thread-a", "/tmp/project");
      insertThread(codexHome, "thread-b", "/tmp/project");
      insertLog(
        codexHome,
        "thread-a",
        "app_server.request otel.name=\"thread/resume\" app_server.client_name=\"codex-tui\"",
        "pid:101:process-a",
      );
      insertLog(
        codexHome,
        "thread-b",
        "app_server.request otel.name=\"thread/resume\" app_server.client_name=\"codex-tui\"",
        "pid:202:process-b",
      );

      const result = readCodexResumeLogEvents({
        codexHome,
        cwd: "/tmp/project",
        afterLogId: 0,
        processUuid: "pid:202:process-b",
      });

      expect(result.threadIds).toEqual(["thread-b"]);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("claims one process before watching same-project resumes", async () => {
    const codexHome = tempDir();
    const resumed: string[] = [];
    try {
      setupCodexDatabases(codexHome);
      insertThread(codexHome, "thread-a", "/tmp/project");
      insertThread(codexHome, "thread-b", "/tmp/project");
      const watcher = startCodexResumeLogWatcher({
        codexHome,
        cwd: "/tmp/project",
        pollIntervalMs: 5,
        onResume: (threadId) => resumed.push(threadId),
      });
      insertLog(
        codexHome,
        "thread-a",
        "app_server.request otel.name=\"thread/resume\" app_server.client_name=\"codex-tui\"",
        "pid:101:process-a",
      );
      insertLog(
        codexHome,
        "thread-b",
        "app_server.request otel.name=\"thread/resume\" app_server.client_name=\"codex-tui\"",
        "pid:202:process-b",
      );

      watcher.claimProcessForThread("thread-b");
      await new Promise((resolve) => setTimeout(resolve, 20));
      watcher.stop();

      expect(resumed).toEqual(["thread-b"]);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

describe("isCodexThreadSavedForCwd", () => {
  it("returns true when a thread is saved for the current project cwd", () => {
    const codexHome = tempDir();
    try {
      setupCodexDatabases(codexHome);
      insertThread(codexHome, "thread-current", "/tmp/project");

      expect(isCodexThreadSavedForCwd({
        codexHome,
        cwd: "/tmp/project",
        threadId: "thread-current",
      })).toBe(true);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("returns false for missing threads and threads from other projects", () => {
    const codexHome = tempDir();
    try {
      setupCodexDatabases(codexHome);
      insertThread(codexHome, "thread-other", "/tmp/other");

      expect(isCodexThreadSavedForCwd({
        codexHome,
        cwd: "/tmp/project",
        threadId: "thread-missing",
      })).toBe(false);
      expect(isCodexThreadSavedForCwd({
        codexHome,
        cwd: "/tmp/project",
        threadId: "thread-other",
      })).toBe(false);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
