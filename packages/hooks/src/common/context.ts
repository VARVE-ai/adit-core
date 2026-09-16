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
  closeDatabase,
  getSessionByPlatformSessionId,
  insertSession,
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
import { dirname, resolve } from "node:path";
import {
  attachForkAlias,
  findForkedSession,
  FORK_CHECK_PENDING_KEY,
  isForkCheckPending,
  lookupForkedSession,
  resolvePendingFork,
  type ForkLookup,
} from "./session-fork.js";
import { bindSessionProject, readSessionProject } from "./session-project.js";
import { parseHookStdin } from "./hook-stdin.js";

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
  if (!projectRoot || !platformSessionId) return null;

  // Only a project with a valid manifest records events. Legacy projects
  // (awaiting `adit init` migration) and damaged manifests skip silently —
  // hooks must never mint an identity or block the agent.
  let config: AditConfig;
  try {
    const binding = readSessionProject(platform, platformSessionId);
    if (binding) {
      config = loadHookConfig(binding.projectRoot);
      if (config.projectId !== binding.projectId) return null;
    } else {
      config = loadHookConfig(projectRoot);
      if (config.initialization !== "initialized" || !existsSync(config.dbPath)) return null;
      const initial = loadHookConfig(cwd, false);
      const candidates = new Map<string, AditConfig>([[config.projectRoot, config]]);
      if (initial.initialization === "initialized") candidates.set(initial.projectRoot, initial);
      // Upgrade continuity: an existing session may already be in a parent's
      // database before this version introduced bindings or hooks were refreshed.
      for (let dir = dirname(resolve(cwd)); ; dir = dirname(dir)) {
        if (existsSync(`${dir}/.adit/project.json`)) {
          const ancestor = loadHookConfig(dir);
          candidates.set(ancestor.projectRoot, ancestor);
        }
        if (dirname(dir) === dir) break;
      }
      let owner: AditConfig | undefined;
      for (const candidate of candidates.values()) {
        if (!existsSync(candidate.dbPath)) continue;
        const candidateDb = openDatabase(candidate.dbPath);
        try {
          let previous = getSessionByPlatformSessionId(candidateDb, platformSessionId);
          if (!previous && options.transcriptPath) {
            try {
              previous = findForkedSession(candidateDb, {
                projectId: candidate.projectId, platform,
                platformSessionId, transcriptPath: options.transcriptPath,
              });
            } catch { /* failed fork detection must not prevent a new session */ }
          }
          if (previous) {
            owner = candidate;
            break;
          }
        } finally {
          closeDatabase(candidateDb);
        }
      }
      config = owner ?? initial;
      if (config.initialization !== "initialized" || !existsSync(config.dbPath)) return null;
      const saved = bindSessionProject(platform, platformSessionId, config);
      config = loadHookConfig(saved.projectRoot);
      if (config.projectId !== saved.projectId) return null;
    }
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
  if (session && options.transcriptPath && isForkCheckPending(session)) {
    // Created while the platform had not written its transcript yet: now
    // that a later hook can read it, the fork check gets its second chance.
    session = resolvePendingFork(db, {
      session,
      projectId: config.projectId,
      clientId: config.clientId,
      platform,
      platformSessionId,
      transcriptPath: options.transcriptPath,
    }) ?? session;
  }
  let forkCheckPending = false;
  if (!session && options.transcriptPath) {
    // First sight of this platform session id: is it a fork of a recent
    // conversation (edited + resent message)? Then keep recording into the
    // original session instead of starting a new one.
    const fork = attachForkedSession(db, {
      projectId: config.projectId,
      clientId: config.clientId,
      platform,
      platformSessionId,
      transcriptPath: options.transcriptPath,
    });
    if (fork.kind === "fork") session = fork.original;
    forkCheckPending = fork.kind === "pending";
  }
  if (!session) {
    const id = generateId();
    const now = new Date().toISOString();
    const branch = await safeGetCurrentBranch(cwd);
    const remoteUrl = await safeGetRemoteUrl(cwd);

    session = db.transaction(() => {
      const existing = getSessionByPlatformSessionId(db, platformSessionId);
      if (existing) return existing;
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
        // Claude Code writes a fork's transcript only after this first hook
        // has returned; the check is repeated on later hooks until readable.
        ...(forkCheckPending ? { [FORK_CHECK_PENDING_KEY]: true } : {}),
      }),
      vclockJson: serialize(createClock(config.clientId)),
      platformSessionId,
    });

      return getSessionByPlatformSessionId(db, platformSessionId)!;
    })();
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
): ForkLookup {
  try {
    const lookup = lookupForkedSession(db, input);
    if (lookup.kind === "fork") attachForkAlias(db, lookup.original, input);
    return lookup;
  } catch {
    return { kind: "none" };
  }
}

function loadHookConfig(projectRoot: string, fixed = true): AditConfig {
  const originalProjectRoot = process.env.ADIT_PROJECT_ROOT;
  const originalDataDir = process.env.ADIT_DATA_DIR;
  const originalDbPath = process.env.ADIT_DB_PATH;
  if (fixed) process.env.ADIT_PROJECT_ROOT = projectRoot;
  else delete process.env.ADIT_PROJECT_ROOT;
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
        finish(resolve, parseHookStdin(data));
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
          finish(resolve, parseHookStdin(data));
        } catch {
          finish(reject, new Error("Stdin timeout: incomplete JSON"));
        }
      } else {
        finish(reject, new Error("No stdin data received"));
      }
    }, 3000).unref();
  });
}
