/**
 * Shared hook context — initializes DB, config, and session
 * for any hook handler.
 *
 * Fail-open design: if anything goes wrong during setup,
 * the hook exits silently (exit 0) so the AI agent is never blocked.
 */

import {
  ProjectManifestError,
  loadConfig,
  openDatabase,
  getSessionByPlatformSessionId,
  insertSession,
  insertSessionPlatformAlias,
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
import { findForkedSession, markSupersededPrompt } from "./session-fork.js";

export interface HookContext {
  db: Database.Database;
  config: AditConfig;
  session: AditSession;
}

export interface HookContextOptions {
  projectRoot?: string | null;
  /** The platform's transcript file for this session, when the hook reports one. */
  transcriptPath?: string | null;
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

  // Only a project with a valid manifest records events. Legacy projects
  // (awaiting `adit init` migration) and damaged manifests skip silently —
  // hooks must never mint an identity or block the agent.
  let config: AditConfig;
  try {
    config = loadHookConfig(projectRoot);
  } catch (err) {
    if (err instanceof ProjectManifestError) return null;
    throw err;
  }
  if (config.initialization !== "initialized") return null;
  if (!existsSync(config.dbPath)) return null;

  // A platform session ID is the only reliable way to associate an incoming
  // hook with its conversation. Never guess by reusing the most recent local
  // session: concurrent windows would silently contaminate each other.
  if (!platformSessionId) return null;

  const db = openDatabase(config.dbPath);

  // The same platform session ID always reattaches to the same local row
  // (directly, or through an alias recorded for a client-side fork).
  let session: AditSession | null = getSessionByPlatformSessionId(db, platformSessionId);
  if (!session && options.transcriptPath) {
    // First sight of this platform session id: is it a fork of a recent
    // conversation (edited + resent message)? Then keep recording into the
    // original session instead of starting a new one.
    session = attachForkedSession(db, {
      projectId: config.projectId,
      clientId: config.clientId,
      platform,
      platformSessionId,
      transcriptPath: options.transcriptPath,
    });
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
        transcriptPath: options.transcriptPath ?? undefined,
      }),
      vclockJson: serialize(createClock(config.clientId)),
      platformSessionId,
    });

    session = getSessionByPlatformSessionId(db, platformSessionId)!;
  }

  return { db, config, session };
}

/**
 * Fork detection + alias registration, fail-open: any problem means the
 * caller proceeds to create a fresh session as before.
 */
function attachForkedSession(
  db: Database.Database,
  input: {
    projectId: string;
    clientId: string;
    platform: Platform;
    platformSessionId: string;
    transcriptPath: string;
  },
): AditSession | null {
  try {
    const original = findForkedSession(db, input);
    if (!original) return null;
    insertSessionPlatformAlias(db, {
      platformSessionId: input.platformSessionId,
      sessionId: original.id,
    });
    markSupersededPrompt(db, original, input.clientId);
    return original;
  } catch {
    return null;
  }
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
