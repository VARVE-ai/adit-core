import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface CodexResumeLogWatcher {
  claimProcessForThread(threadId: string): void;
  stop(): void;
}

export interface CodexResumeLogReadResult {
  lastLogId: number;
  threadIds: string[];
}

export interface CodexResumeLogReadOptions {
  cwd: string;
  afterLogId: number;
  codexHome?: string;
  processUuid?: string;
}

export interface CodexSavedThreadLookupOptions {
  cwd: string;
  threadId: string;
  codexHome?: string;
  onDiagnostic?: (message: string) => void;
}

export interface StartCodexResumeLogWatcherOptions {
  processId?: number;
  cwd: string;
  onResume: (threadId: string) => void;
  codexHome?: string;
  pollIntervalMs?: number;
  afterLogId?: number;
}

interface ResumeLogRow {
  id: number;
  thread_id: string | null;
  process_uuid: string | null;
}

interface ThreadCwdRow {
  cwd: string | null;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const THREAD_RESUME_MARKER = "%otel.name=\"thread/resume\"%";
const CODEX_TUI_MARKER = "%app_server.client_name=\"codex-tui\"%";

export function startCodexResumeLogWatcher(
  opts: StartCodexResumeLogWatcherOptions,
): CodexResumeLogWatcher {
  let stopped = false;
  let lastLogId = opts.afterLogId ?? readMaxCodexLogId(opts.codexHome);
  const startedAfterLogId = lastLogId;
  let claimedThreadId: string | null = null;
  let processUuid: string | null = null;
  let claimingProcess = false;
  let nextProcessClaimAt = 0;

  const poll = () => {
    if (stopped) return;
    if (!processUuid && claimedThreadId) {
      processUuid = readCodexProcessUuidForThread({
        threadId: claimedThreadId,
        afterLogId: startedAfterLogId,
        codexHome: opts.codexHome,
      });
    }
    if (!processUuid) {
      if (opts.processId && !claimingProcess && Date.now() >= nextProcessClaimAt) {
        claimingProcess = true;
        void readCodexProcessUuidForProcess(opts.processId, startedAfterLogId, opts.codexHome)
          .then((id) => {
            if (stopped || processUuid || !id) return;
            processUuid = id;
            poll();
          })
          .finally(() => {
            claimingProcess = false;
            nextProcessClaimAt = Date.now() + 1000;
          });
      }
      return;
    }
    const result = readCodexResumeLogEvents({
      cwd: opts.cwd,
      codexHome: opts.codexHome,
      afterLogId: lastLogId,
      processUuid,
    });
    lastLogId = Math.max(lastLogId, result.lastLogId);
    for (const threadId of result.threadIds) {
      opts.onResume(threadId);
    }
  };

  const timer = setInterval(poll, opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  timer.unref?.();
  poll();

  return {
    claimProcessForThread(threadId: string) {
      const nextThreadId = readString(threadId);
      if (!nextThreadId || processUuid) return;
      claimedThreadId = nextThreadId;
      poll();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function readCodexResumeLogEvents(
  opts: CodexResumeLogReadOptions,
): CodexResumeLogReadResult {
  const codexHome = resolveCodexHome(opts.codexHome);
  const logsPath = join(codexHome, "logs_2.sqlite");
  const statePath = join(codexHome, "state_5.sqlite");
  if (!existsSync(logsPath) || !existsSync(statePath)) {
    return { lastLogId: opts.afterLogId, threadIds: [] };
  }

  let logsDb: Database.Database | null = null;
  let stateDb: Database.Database | null = null;
  try {
    logsDb = openReadonlyDatabase(logsPath);
    stateDb = openReadonlyDatabase(statePath);
    const processFilter = opts.processUuid ? "AND process_uuid = ?" : "";
    const params = opts.processUuid
      ? [opts.afterLogId, THREAD_RESUME_MARKER, CODEX_TUI_MARKER, opts.processUuid]
      : [opts.afterLogId, THREAD_RESUME_MARKER, CODEX_TUI_MARKER];
    const rows = logsDb.prepare(`
      SELECT id, thread_id, process_uuid
      FROM logs
      WHERE id > ?
        AND thread_id IS NOT NULL
        AND feedback_log_body LIKE ?
        AND feedback_log_body LIKE ?
        ${processFilter}
      ORDER BY id ASC
      LIMIT 50
    `).all(...params) as ResumeLogRow[];

    let lastLogId = opts.afterLogId;
    const threadIds: string[] = [];
    const targetCwd = normalizePath(opts.cwd);
    const cwdForThread = stateDb.prepare("SELECT cwd FROM threads WHERE id = ? LIMIT 1");

    for (const row of rows) {
      lastLogId = Math.max(lastLogId, row.id);
      const threadId = readString(row.thread_id);
      if (!threadId) continue;
      const thread = cwdForThread.get(threadId) as ThreadCwdRow | undefined;
      const threadCwd = readString(thread?.cwd);
      if (!threadCwd) continue;
      if (normalizePath(threadCwd) === targetCwd) {
        threadIds.push(threadId);
      }
    }

    return { lastLogId, threadIds };
  } catch {
    return { lastLogId: opts.afterLogId, threadIds: [] };
  } finally {
    try {
      logsDb?.close();
    } catch {}
    try {
      stateDb?.close();
    } catch {}
  }
}

function readCodexProcessUuidForThread(opts: {
  threadId: string;
  afterLogId: number;
  codexHome?: string;
}): string | null {
  const logsPath = join(resolveCodexHome(opts.codexHome), "logs_2.sqlite");
  if (!existsSync(logsPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = openReadonlyDatabase(logsPath);
    const row = db.prepare(`
      SELECT process_uuid
      FROM logs
      WHERE id > ?
        AND thread_id = ?
        AND process_uuid IS NOT NULL
        AND feedback_log_body LIKE ?
      ORDER BY id ASC
      LIMIT 1
    `).get(
      opts.afterLogId,
      opts.threadId,
      CODEX_TUI_MARKER,
    ) as { process_uuid?: string | null } | undefined;
    return readString(row?.process_uuid);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

async function readCodexProcessUuidForProcess(
  rootPid: number,
  afterLogId: number,
  codexHome?: string,
): Promise<string | null> {
  let db: Database.Database | null = null;
  try {
    db = openReadonlyDatabase(join(resolveCodexHome(codexHome), "logs_2.sqlite"));
    const rows = db.prepare(`
      SELECT DISTINCT process_uuid FROM logs
      WHERE id > ? AND process_uuid IS NOT NULL AND feedback_log_body LIKE ?
    `).all(afterLogId, CODEX_TUI_MARKER) as Array<{ process_uuid: string }>;
    db.close();
    db = null;
    if (!rows.length) return null;
    const candidates = rows.map((row) => ({
      uuid: row.process_uuid,
      pid: Number(/^pid:(\d+):/.exec(row.process_uuid)?.[1]),
    }));
    const direct = candidates.find((item) => item.pid === rootPid);
    if (direct) return direct.uuid;

    // npm/cmd launchers own the child handle; the native Codex writer is a descendant.
    const run = promisify(execFile);
    const parents = new Map<number, number>();
    if (process.platform === "win32") {
      const { stdout } = await run("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
      ], { windowsHide: true, timeout: 5000 });
      const parsed = JSON.parse(stdout);
      for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
        parents.set(row.ProcessId, row.ParentProcessId);
      }
    } else {
      const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid="], { timeout: 5000 });
      for (const line of stdout.trim().split("\n")) {
        const [pid, parent] = line.trim().split(/\s+/).map(Number);
        parents.set(pid, parent);
      }
    }
    return candidates.find(({ pid }) => {
      const seen = new Set<number>();
      while (pid && !seen.has(pid)) {
        if (pid === rootPid) return true;
        seen.add(pid);
        pid = parents.get(pid) ?? 0;
      }
      return false;
    })?.uuid ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function isCodexThreadSavedForCwd(opts: CodexSavedThreadLookupOptions): boolean {
  const threadId = readString(opts.threadId);
  if (!threadId) return false;
  const statePath = join(resolveCodexHome(opts.codexHome), "state_5.sqlite");
  if (!existsSync(statePath)) {
    opts.onDiagnostic?.("thread index: database missing");
    return false;
  }

  let db: Database.Database | null = null;
  try {
    db = openReadonlyDatabase(statePath);
    const row = db.prepare("SELECT cwd FROM threads WHERE id = ? LIMIT 1").get(threadId) as
      | ThreadCwdRow
      | undefined;
    const threadCwd = readString(row?.cwd);
    const saved = Boolean(threadCwd && normalizePath(threadCwd) === normalizePath(opts.cwd));
    opts.onDiagnostic?.(`thread index: ${saved ? "matched" : threadCwd ? "cwd mismatch" : "missing row"}`);
    return saved;
  } catch (error) {
    opts.onDiagnostic?.(`thread index read failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export function readMaxCodexLogId(codexHome?: string): number {
  const logsPath = join(resolveCodexHome(codexHome), "logs_2.sqlite");
  if (!existsSync(logsPath)) return 0;
  let db: Database.Database | null = null;
  try {
    db = openReadonlyDatabase(logsPath);
    const row = db.prepare("SELECT max(id) AS id FROM logs").get() as { id?: number | null };
    return typeof row.id === "number" ? row.id : 0;
  } catch {
    return 0;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function openReadonlyDatabase(filePath: string): Database.Database {
  return new Database(filePath, {
    fileMustExist: true,
    readonly: true,
  });
}

function resolveCodexHome(codexHome?: string): string {
  return codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function normalizePath(value: string): string {
  const resolved = resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
