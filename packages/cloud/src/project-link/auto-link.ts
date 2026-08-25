/**
 * Automatic project-link sync — fire-and-forget on session-start.
 *
 * Spawns a detached child process to run the full project-link flow
 * (branches, commits, documents) in the background. The process is
 * independent of the hook — it won't be killed by the 10-second
 * hook timeout and won't block the AI agent.
 *
 * Precondition checks (all must pass to trigger):
 * 1. Auto-sync not disabled via ADIT_PROJECT_LINK_AUTO_SYNC=false
 * 2. Valid credentials exist (env token or stored credentials)
 * 3. Server URL is resolvable
 * 4. Cached project-link data is stale (older than staleHours)
 *
 * The detached process runs `npx adit cloud link --json --skip-qualify`
 * with inherited environment, so credentials and config are available.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { loadCloudConfig, DEFAULT_SERVER_URL } from "../config.js";
import {
  loadCredentials,
  credentialsFromEnvToken,
  isSyncDisabled,
} from "../auth/credentials.js";
import { getProjectLinkCache } from "./cache.js";
import { runGit } from "@varveai/adit-engine";
import { loadConfig } from "@varveai/adit-core";

export const REFS_FINGERPRINT_CACHE_KEY = "__adit_git_refs_fingerprint";

/**
 * Trigger a background project-link sync if credentials exist and the
 * cached link data is stale or git refs changed since the last check.
 *
 * This function is designed to be called as fire-and-forget:
 *   triggerProjectLinkSync(db, projectId, projectRoot).catch(() => {})
 *
 * It spawns a fully detached child process that outlives the hook
 * process, so the 10-second hook timeout does not apply.
 */
export async function triggerProjectLinkSync(
  db: Database.Database,
  projectId: string,
  projectRoot: string,
): Promise<void> {
  const cloudConfig = loadCloudConfig();

  // 0. Check if project-link auto-sync is enabled
  if (!cloudConfig.projectLink.autoSync) return;

  // 1. Circuit breaker — skip if cloud sync is disabled due to failures
  if (isSyncDisabled()) return;

  // 2. Check credentials exist (env token or stored) and resolve server URL
  let serverUrl: string | null = null;
  const storedCredentials = loadCredentials();

  if (process.env.ADIT_AUTH_TOKEN) {
    serverUrl = cloudConfig.serverUrl ?? DEFAULT_SERVER_URL;
    const clientId = storedCredentials?.clientId ?? loadConfig().clientId;
    const creds = credentialsFromEnvToken(serverUrl, clientId);
    if (!creds) return;
  } else {
    if (!storedCredentials) return;
    serverUrl = cloudConfig.serverUrl ?? storedCredentials.serverUrl;

    // Single-server binding: don't send credentials to wrong server
    if (cloudConfig.serverUrl && storedCredentials.serverUrl !== cloudConfig.serverUrl) {
      return;
    }
  }

  if (!serverUrl) return;

  // 3. Check staleness. If the cache is still fresh, do one cheap refs
  //    fingerprint check so new branches/commits can still trigger a git-only
  //    link without scanning docs.
  // Only a valid manifest project auto-links. No synthesized fallback
  // repositories — a made-up ID never matches the real cache entries, which
  // used to force a spawn on every session start.
  let projectConfig: ReturnType<typeof loadConfig>;
  try {
    projectConfig = loadConfig(projectRoot);
  } catch {
    return;
  }
  if (projectConfig.initialization !== "initialized" || projectConfig.repositories.length === 0) {
    return;
  }
  const repositories = projectConfig.repositories;
  let gitOnlySync = false;
  let shouldSync = false;

  for (const repository of repositories) {
    const cache = getProjectLinkCache(db, projectId, serverUrl, repository.localRepositoryId);
    if (!cache?.lastBranchSyncAt) {
      shouldSync = true;
      break;
    }

    const staleMs = cloudConfig.projectLink.staleHours * 60 * 60 * 1000;
    const lastSyncTime = new Date(cache.lastBranchSyncAt).getTime();
    // Guard against corrupted date strings that produce NaN
    if (Number.isNaN(lastSyncTime) || Date.now() - lastSyncTime >= staleMs) {
      shouldSync = true;
      break;
    }

    const refsFingerprint = await collectGitRefsFingerprint(repository.path);
    const cachedRefsFingerprint = typeof cache.docHashes[REFS_FINGERPRINT_CACHE_KEY] === "string"
      ? cache.docHashes[REFS_FINGERPRINT_CACHE_KEY]
      : null;
    if (refsFingerprint && refsFingerprint !== cachedRefsFingerprint) {
      gitOnlySync = true;
      shouldSync = true;
      break;
    }
  }

  if (!shouldSync) return;

  // 4. Spawn detached child process to run the full link flow.
  //    Uses `npx adit cloud link` which handles its own
  //    credential loading, database opening, and error handling.
  try {
    const args = ["adit", "cloud", "link", "--json", "--skip-qualify"];
    if (gitOnlySync) {
      args.push("--skip-docs");
    }

    // Windows needs a shell to resolve npx.cmd, but Node deprecated passing
    // an args array alongside shell:true (DEP0190 — warning lands on the
    // hook's stderr). Build a single quoted command line there instead;
    // POSIX keeps the args-array form with no shell.
    const useShell = process.platform === "win32";
    const child = useShell
      ? spawn(
          [npxCommand(), ...args].map(quoteForWindowsShell).join(" "),
          {
            cwd: projectRoot,
            stdio: ["ignore", "ignore", "ignore"],
            detached: true,
            shell: true,
            windowsHide: true,
          },
        )
      : spawn(
          npxCommand(),
          args,
          {
            cwd: projectRoot,
            stdio: ["ignore", "ignore", "ignore"],
            detached: true,
            windowsHide: true,
          },
        );
    child.unref();
    child.on("error", () => {
      // fail-open
    });
  } catch {
    // fail-open — spawn itself may throw (e.g. npx not found)
  }
}

/** Quote an argument for cmd.exe when composing a single shell command line. */
function quoteForWindowsShell(arg: string): string {
  if (arg.length > 0 && !/[\s"^&|<>()%!]/u.test(arg)) return arg;
  return `"${arg.replace(/"/gu, '""')}"`;
}

export async function collectGitRefsFingerprint(projectRoot: string): Promise<string | null> {
  const result = await runGit(
    [
      "for-each-ref",
      "refs/heads",
      "refs/remotes",
      "--sort=refname",
      "--format=%(refname)%00%(objectname)",
    ],
    { cwd: projectRoot, timeout: 5_000 },
  );

  if (result.exitCode !== 0) return null;
  return createHash("sha256").update(result.stdout).digest("hex");
}

function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}
