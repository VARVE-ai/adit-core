/**
 * `adit status` — Show ADIT status for the current project.
 *
 * Displays a styled overview with session cards, git state, sync info,
 * and hook configuration. Inspired by Entire CLI's v0.4.6 session card
 * format but adapted for ADIT's richer event model.
 */

import { existsSync } from "node:fs";
import pc from "picocolors";
import {
  ProjectManifestError,
  computeRepositoryDrift,
  readProjectManifest,
  loadConfig,
  openDatabase,
  closeDatabase,
  getLatestSession,
  countEvents,
  queryEvents,
  getSyncState,
  findGitRoot,
  type AditConfig,
} from "@varveai/adit-core";
import {
  hasUncommittedChanges,
  getCurrentBranch,
  getHeadSha,
} from "@varveai/adit-engine";
import { getAdapter } from "@varveai/adit-hooks/adapters";
import { ensureConnectedPlatformsRecorded } from "./connected-platforms.js";
import { statusDot, joinDim, sectionHeader, horizontalRule, timeAgo } from "../utils/format.js";
import { truncate } from "../utils/summary.js";

/** Display-name map for platforms (matches adapter displayName but avoids import) */
const platformLabel: Record<string, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  copilot: "Copilot",
  opencode: "OpenCode",
  codex: "Codex",
  gemini: "Gemini",
};

export async function statusCommand(opts?: { json?: boolean }): Promise<void> {
  let config: AditConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ProjectManifestError) {
      if (opts?.json) {
        console.log(JSON.stringify({ initialized: false, corrupt: true, reason: err.message }, null, 2));
      } else {
        console.log();
        console.log(`${statusDot(false)} ${pc.bold("Project configuration damaged")}`);
        console.log();
        console.log(pc.dim(err.message));
        console.log(pc.dim("Restore .adit/project.json from a backup, or run 'adit init' to rebuild it."));
        console.log();
      }
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  const gitRoot = findGitRoot() ?? config.projectRoot;

  // Gather status info
  const status: Record<string, unknown> = {};

  // 1. Initialization state — the manifest is the single authority.
  const dbExists = existsSync(config.dbPath);
  status.initialized = config.initialization === "initialized" && dbExists;

  if (!status.initialized) {
    const legacy = config.initialization === "legacy";
    if (opts?.json) {
      console.log(JSON.stringify({ initialized: false, migrationNeeded: legacy }, null, 2));
    } else {
      console.log();
      console.log(`${statusDot(false)} ${pc.bold(legacy ? "Migration needed" : "Not initialized")}`);
      console.log();
      if (legacy) {
        console.log(pc.dim("ADIT has been upgraded. Run 'adit init' here to migrate —"));
        console.log(pc.dim("your project identity and history are preserved. Recording is paused until then."));
      } else if (config.initialization === "initialized") {
        console.log(pc.dim("The local database is missing. Run 'adit init' to rebuild it."));
      } else {
        console.log(pc.dim("Run 'adit init' to get started."));
      }
      console.log();
    }
    return;
  }

  // 2. Check hook configuration for the platforms the user connected.
  //    An unconnected platform's leftover config is the user's choice, not
  //    an incomplete install — only connected platforms are validated.
  const connectedPlatforms = await ensureConnectedPlatformsRecorded(config.projectRoot);
  const connectedAdapters = connectedPlatforms
    .map((platform) => getAdapter(platform))
    .filter((a) => a.hookMappings.length > 0);
  const installedPlatforms: string[] = [];
  const missingPlatforms: string[] = [];

  for (const adapter of connectedAdapters) {
    const result = await adapter.validateInstallation(gitRoot);
    if (result.valid) {
      installedPlatforms.push(adapter.displayName);
    } else {
      missingPlatforms.push(adapter.displayName);
    }
  }

  status.hooks = {
    installed: installedPlatforms,
    missing: missingPlatforms,
    allInstalled: missingPlatforms.length === 0 && installedPlatforms.length > 0,
  };

  // 3. Database + session info
  const db = openDatabase(config.dbPath);
  let latestPromptText: string | null = null;

  try {
    // Most recently active session, derived from its events.
    const session = getLatestSession(db, config.projectId, config.clientId);
    status.session = session
      ? {
          id: session.id,
          platform: session.platform,
          startedAt: session.startedAt,
        }
      : null;

    // Fetch latest prompt text for the session card
    if (session) {
      const latestPrompts = queryEvents(db, {
        sessionId: session.id,
        eventType: "prompt_submit",
        limit: 1,
      });
      latestPromptText = latestPrompts[0]?.promptText ?? null;
    }

    // Event counts — use countEvents() for accurate total
    const totalEvents = countEvents(db, config.projectId);
    status.events = {
      total: totalEvents,
    };

    // Unsynced events — count events after the last sync cursor.
    // Resolve server URL the same way auto-sync does: env var → credentials.
    let syncServerUrl = process.env.ADIT_CLOUD_URL ?? null;
    try {
      const { loadCredentials } = await import("@varveai/adit-cloud");
      const credentials = loadCredentials();
      syncServerUrl ??= credentials?.serverUrl ?? null;
      // Cloud sync health — surfaced in the Warnings section below so
      // silent fail-open behavior is still visible to the user.
      status.cloud = credentials
        ? {
            loggedIn: true,
            syncDisabled: credentials.syncDisabled === true,
            syncErrorCount: credentials.syncErrorCount ?? 0,
            lastAuthFailure: credentials.lastAuthFailure ?? null,
          }
        : { loggedIn: false };
    } catch {
      // @varveai/adit-cloud not available
    }
    const syncState = getSyncState(db, syncServerUrl ?? "");
    if (syncState?.lastSyncedEventId) {
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM events e
         JOIN sessions s ON e.session_id = s.id
         WHERE e.id > ? AND s.project_id = ?`,
      ).get(syncState.lastSyncedEventId, config.projectId) as { cnt: number };
      (status.events as Record<string, unknown>).unsynced = row.cnt;
    } else {
      // Never synced — all events are unsynced
      (status.events as Record<string, unknown>).unsynced = totalEvents;
    }

  } finally {
    closeDatabase(db);
  }

  // 4. Git info
  const manifest = readProjectManifest(config.projectRoot);
  if (manifest && manifest.repositories.some((repo) => repo.relativePath !== ".")) {
    const drift = computeRepositoryDrift(config.projectRoot, manifest);
    status.git = {
      workspace: true,
      repositories: drift.registered.length,
      registered: drift.registered,
      unregistered: drift.unregistered,
      missingRepositories: drift.missing,
    };
  } else {
    const [branch, headSha, dirty] = await Promise.all([
      getCurrentBranch(config.projectRoot),
      getHeadSha(config.projectRoot),
      hasUncommittedChanges(config.projectRoot),
    ]);
    status.git = {
      branch,
      head: headSha?.substring(0, 8) ?? null,
      dirty,
    };
  }

  // ──────────────────────────────────────────────
  // Output
  // ──────────────────────────────────────────────

  if (opts?.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  const ruleWidth = 50;
  const hooksStatus = status.hooks as {
    allInstalled: boolean;
    installed: string[];
    missing: string[];
  };
  const session = status.session as {
    id: string;
    platform: string;
    startedAt: string;
  } | null;
  const events = status.events as { total: number; unsynced: number };
  const cloud = status.cloud as
    | {
        loggedIn: boolean;
        syncDisabled?: boolean;
        syncErrorCount?: number;
        lastAuthFailure?: { at: string; stage: string; message: string } | null;
      }
    | undefined;
  const git = status.git as
    | {
        workspace: true;
        repositories: number;
        registered: string[];
        unregistered: string[];
        missingRepositories: string[];
      }
    | {
        workspace?: false;
        branch: string | null;
        head: string | null;
        dirty: boolean;
      };

  // ── Status line ──────────────────────────────
  console.log();
  const isActive = session !== null;
  const hooksList = hooksStatus.installed.length > 0
    ? hooksStatus.installed.join(", ")
    : null;
  const branchLabel = git.workspace
    ? pc.cyan(`${git.repositories} repositories`)
    : git.branch ? pc.cyan(git.branch) : pc.yellow("detached");

  console.log(
    joinDim([
      `${statusDot(isActive)} ${pc.bold(isActive ? "Active" : "Idle")}`,
      hooksList,
      git.workspace ? `${git.repositories} repos` : `branch ${branchLabel}`,
    ]),
  );

  // ── Session card ─────────────────────────────
  console.log();
  console.log(sectionHeader("Session", ruleWidth));
  console.log();

  if (session) {
    const label = platformLabel[session.platform] ?? session.platform;
    const shortId = session.id.substring(0, 12);
    console.log(joinDim([pc.bold(label), pc.dim(shortId)]));

    // Latest prompt (Entire-style quoted line)
    if (latestPromptText) {
      const cleaned = latestPromptText.replace(/\n/g, " ").trim();
      console.log(pc.dim("> ") + `"${truncate(cleaned, 60)}"`);
    }

    // Stats line
    const statsLine = joinDim([
      `started ${timeAgo(session.startedAt)}`,
      `${events.total} events`,
    ]);
    console.log(pc.dim(statsLine));
  } else {
    console.log(pc.dim("No sessions"));
  }

  // ── Git ──────────────────────────────────────
  console.log();
  console.log(sectionHeader("Git", ruleWidth));
  console.log();

  if (git.workspace) {
    console.log(joinDim([
      `${git.repositories} registered repositories`,
    ]));
    for (const path of git.registered) {
      const missing = git.missingRepositories.includes(path);
      console.log(pc.dim(`  - ${path}`) + (missing ? pc.yellow("  (missing)") : ""));
    }
  } else {
    const headShort = git.head ?? "unknown";
    const treeStatus = git.dirty
      ? pc.yellow("dirty")
      : pc.green("clean");
    console.log(joinDim([
      `branch ${branchLabel}`,
      headShort,
      treeStatus,
    ]));
  }

  // ── Sync ─────────────────────────────────────
  console.log();
  console.log(sectionHeader("Sync", ruleWidth));
  console.log();

  if (events.unsynced === 0) {
    console.log(pc.green("all events synced"));
  } else {
    console.log(pc.yellow(`${events.unsynced} events unsynced`));
  }

  // ── Warnings (only if issues) ────────────────
  const warnings: string[] = [];
  if (missingPlatforms.length > 0) {
    warnings.push(`hooks incomplete: ${missingPlatforms.join(", ")}`);
  }
  if (git.workspace && git.unregistered.length > 0) {
    warnings.push(
      `unregistered repositories: ${git.unregistered.join(", ")} — run 'adit init' to add them`,
    );
  }
  if (git.workspace && git.missingRepositories.length > 0) {
    warnings.push(
      `registered repositories missing: ${git.missingRepositories.join(", ")} — run 'adit init' to update the list`,
    );
  }
  if (cloud?.syncDisabled) {
    warnings.push(
      "cloud auto-sync paused after repeated failures — run 'adit cloud sync' to retry now (auto-resumes within 1h)",
    );
  }
  if (cloud?.lastAuthFailure) {
    warnings.push(
      `cloud auth failing (${cloud.lastAuthFailure.stage}, ${timeAgo(cloud.lastAuthFailure.at)}): re-run 'adit cloud login'`,
    );
  }
  if (warnings.length > 0) {
    console.log();
    console.log(sectionHeader("Warnings", ruleWidth));
    console.log();
    for (const warning of warnings) {
      console.log(pc.yellow(warning));
    }
  }

  // ── Footer ───────────────────────────────────
  console.log();
  console.log(horizontalRule(ruleWidth));
  console.log();
}
