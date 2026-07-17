/**
 * Shared hook context — initializes DB, config, and session
 * for any hook handler.
 *
 * Fail-open design: if anything goes wrong during setup,
 * the hook exits silently (exit 0) so the AI agent is never blocked.
 */

import {
  loadConfig,
  openDatabase,
  getActiveSession,
  getSessionByPlatformSessionId,
  insertSession,
  reviveSession,
  generateId,
  createClock,
  serialize,
  type AditConfig,
  type AditSession,
  type Platform,
} from "@varveai/adit-core";
import type Database from "better-sqlite3";
import { getCurrentBranch, getRemoteUrl } from "@varveai/adit-engine";
import { existsSync } from "node:fs";

export interface HookContext {
  db: Database.Database;
  config: AditConfig;
  session: AditSession;
}

export interface HookContextOptions {
  projectRoot?: string | null;
}

/** Initialize the hook context (DB + session) */
export async function initHookContext(
  cwd: string,
  platform: Platform,
  platformSessionId?: string,
  options: HookContextOptions = {},
): Promise<HookContext | null> {
  const projectRoot = options.projectRoot ?? null;
  if (!projectRoot) return null;

  const config = loadHookConfig(projectRoot);
  if (!existsSync(config.dbPath)) return null;

  const db = openDatabase(config.dbPath);

  // Get or create session — prefer platform session ID lookup. The
  // sessionless fallback is platform-scoped so events without a session id
  // never attach to another CLI's active session.
  let session: AditSession | null = null;
  if (platformSessionId) {
    session = getSessionByPlatformSessionId(db, platformSessionId);
    // Resume of a closed platform session: reattach to the same row instead
    // of minting a duplicate, and reopen it so later lifecycle handling
    // (session-end, stale sweeps) behaves normally.
    if (session && session.status !== "active") {
      reviveSession(db, session.id);
      session = { ...session, status: "active", endedAt: null };
    }
  } else {
    session = getActiveSession(db, config.projectId, config.clientId, platform);
  }
  if (!session) {
    const id = generateId();
    const now = new Date().toISOString();
    const branch = await safeGetCurrentBranch(cwd);
    const remoteUrl = await safeGetRemoteUrl(cwd);

    insertSession(db, {
      id,
      projectId: config.projectId,
      clientId: config.clientId,
      sessionType: "interactive",
      platform,
      startedAt: now,
      metadataJson: JSON.stringify({
        gitBranch: branch ?? "unknown",
        gitRemoteUrl: remoteUrl ?? undefined,
        workingDirectory: cwd,
      }),
      vclockJson: serialize(createClock(config.clientId)),
      platformSessionId: platformSessionId ?? null,
    });

    // Re-fetch via platform session ID if available, else fall back
    if (platformSessionId) {
      session = getSessionByPlatformSessionId(db, platformSessionId)!;
    } else {
      session = getActiveSession(db, config.projectId, config.clientId, platform)!;
    }
  }

  return { db, config, session };
}

function loadHookConfig(projectRoot: string): AditConfig {
  const originalProjectRoot = process.env.ADIT_PROJECT_ROOT;
  const originalDataDir = process.env.ADIT_DATA_DIR;
  const originalDbPath = process.env.ADIT_DB_PATH;
  process.env.ADIT_PROJECT_ROOT = projectRoot;
  delete process.env.ADIT_DATA_DIR;
  delete process.env.ADIT_DB_PATH;

  try {
    return loadConfig(projectRoot);
  } finally {
    restoreEnv("ADIT_PROJECT_ROOT", originalProjectRoot);
    restoreEnv("ADIT_DATA_DIR", originalDataDir);
    restoreEnv("ADIT_DB_PATH", originalDbPath);
  }
}

function restoreEnv(key: "ADIT_PROJECT_ROOT" | "ADIT_DATA_DIR" | "ADIT_DB_PATH", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function safeGetCurrentBranch(cwd: string): Promise<string | null> {
  try {
    return await getCurrentBranch(cwd);
  } catch {
    return null;
  }
}

async function safeGetRemoteUrl(cwd: string): Promise<string | null> {
  try {
    return await getRemoteUrl(cwd);
  } catch {
    return null;
  }
}

/** Read hook input from stdin (Claude Code sends JSON) */
export async function readStdin(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;

    const finish = <T>(fn: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      // Release the stdin handle so the process can exit naturally instead
      // of relying on process.exit() while libuv handles are still closing
      // (which asserts on Windows).
      process.stdin.pause();
      fn(value);
    };

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      try {
        finish(resolve, JSON.parse(data));
      } catch {
        finish(reject, new Error("Invalid JSON on stdin"));
      }
    });
    process.stdin.on("error", (err) => finish(reject, err));

    // Hard timeout — always fires after 3 seconds regardless of data state.
    // If data was received but stdin never closed (e.g. parent process didn't
    // close the pipe), try to parse whatever we have instead of hanging forever.
    // unref'd so a completed read doesn't keep the process alive for 3s.
    setTimeout(() => {
      if (data) {
        try {
          finish(resolve, JSON.parse(data));
        } catch {
          finish(reject, new Error("Stdin timeout: incomplete JSON"));
        }
      } else {
        finish(reject, new Error("No stdin data received"));
      }
    }, 3000).unref();
  });
}
