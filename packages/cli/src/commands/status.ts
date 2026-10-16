/**
 * `adit status` — Show ADIT status for the current project.
 *
 * Displays a styled overview with session cards, git state, sync info,
 * and hook configuration. Inspired by Entire CLI's v0.4.6 session card
 * format but adapted for ADIT's richer event model.
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
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
import { timeAgo } from "../utils/format.js";
import {
  dim,
  formatCount,
  inTone,
  joinParts,
  localMoment,
  marks,
  plural,
  printEnd,
  printError,
  printLine,
  printRows,
  printTitle,
  shortId,
  stateWord,
  strong,
  truncate,
  type Row,
} from "./cli-style.js";

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
        printError(
          "status",
          `ADIT project configuration is damaged: ${err.message}`,
          `restore .adit/project.json from a backup, or run ${strong("adit init")} to rebuild it`,
        );
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
      printTitle("Status", basename(config.projectRoot));
      if (legacy) {
        printRows([{ label: "State", value: `${stateWord("paused")} · ADIT was upgraded and this project needs a one-time migration` }]);
        printEnd(`${marks.warn} Migration needed · run ${strong("adit init")} here (identity and history are kept)`);
      } else if (config.initialization === "initialized") {
        printRows([{ label: "State", value: `${stateWord("paused")} · the local database is missing` }]);
        printEnd(`${marks.warn} Database missing · run ${strong("adit init")} to rebuild it`);
      } else {
        printRows([{ label: "State", value: "not initialized" }]);
        printEnd(`${marks.skip} Not initialized · run ${strong("adit init")} to get started`);
      }
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
  let lastSyncedAt: string | null = null;

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
    lastSyncedAt = syncState?.lastSyncedAt ?? null;
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

  const now = new Date().toISOString();
  const rows: Row[] = [];
  if (session) {
    rows.push({
      label: "Session",
      value: joinParts([
        stateWord("active"),
        platformLabel[session.platform] ?? session.platform,
        strong(shortId(session.id)),
        `started ${localMoment(session.startedAt, now)} ${dim(`(${timeAgo(session.startedAt)})`)}`,
        plural(events.total, "event"),
      ]),
    });
    if (latestPromptText) {
      rows.push({ label: "Prompt", value: `"${truncate(latestPromptText, 72)}"` });
    }
  } else {
    rows.push({ label: "Session", value: joinParts([stateWord("idle"), "no sessions recorded yet"]) });
  }

  if (git.workspace) {
    const repositories = git.registered.map((path) =>
      git.missingRepositories.includes(path) ? `${path} ${stateWord("missing")}` : path,
    );
    rows.push({ label: "Git", value: repositories.length > 0 ? repositories.join(", ") : "-" });
  } else {
    rows.push({
      label: "Git",
      value: joinParts([
        git.branch ? `branch ${git.branch}` : "detached HEAD",
        git.head,
        git.dirty ? inTone("warning", "uncommitted changes") : "clean",
      ]),
    });
  }

  const loggedIn = cloud?.loggedIn === true;
  rows.push({
    label: "Cloud",
    value: loggedIn
      ? joinParts([
          "logged in",
          lastSyncedAt ? `last sync ${localMoment(lastSyncedAt, now)}` : "never synced",
          events.unsynced > 0 ? inTone("unsynced", `${formatCount(events.unsynced)} unsynced`) : "all synced",
        ])
      : `not logged in ${dim("· events stay on this machine")}`,
  });

  const hookNames = [
    ...hooksStatus.installed,
    ...hooksStatus.missing.map((name) => `${name} ${inTone("warning", "(incomplete)")}`),
  ];
  rows.push({ label: "Hooks", value: hookNames.length > 0 ? hookNames.join(", ") : "none connected" });

  // Issues that need the user; the closing line points at the most useful action.
  const warnings: string[] = [];
  if (hookNames.length === 0) {
    warnings.push(`no AI tools connected · run ${strong("adit init")}`);
  }
  if (missingPlatforms.length > 0) {
    warnings.push(`hooks incomplete for ${missingPlatforms.join(", ")} · run ${strong("adit doctor --fix")}`);
  }
  if (git.workspace && git.unregistered.length > 0) {
    warnings.push(`unregistered repositories: ${git.unregistered.join(", ")} · run ${strong("adit init")} to add them`);
  }
  if (git.workspace && git.missingRepositories.length > 0) {
    warnings.push(`registered repositories missing: ${git.missingRepositories.join(", ")} · run ${strong("adit init")} to update the list`);
  }
  if (cloud?.syncDisabled) {
    warnings.push(`cloud auto-sync paused after repeated failures · run ${strong("adit cloud sync")} to retry now (resumes within 1h)`);
  }
  if (cloud?.lastAuthFailure) {
    warnings.push(`cloud login failing (${cloud.lastAuthFailure.stage}, ${timeAgo(cloud.lastAuthFailure.at)}) · run ${strong("adit cloud login")}`);
  }

  const projectName = basename(config.projectRoot);
  printTitle(
    "Status",
    projectName,
    git.workspace ? plural(git.repositories, "repo") : git.branch ? `branch ${git.branch}` : "detached",
  );
  printRows(rows);
  if (warnings.length > 0) {
    printLine();
    for (const warning of warnings) printLine(`${marks.warn} ${warning}`);
  }

  if (warnings.length > 0) {
    printEnd(`${marks.warn} ${plural(warnings.length, "issue")} need attention`);
  } else if (loggedIn && events.unsynced > 0) {
    printEnd(`${marks.warn} ${plural(events.unsynced, "event")} not synced · run ${strong("adit cloud sync")}`);
  } else if (!loggedIn) {
    printEnd(`${marks.skip} Recording locally · run ${strong("adit cloud login")} to sync to Cloud`);
  } else {
    printEnd(`${marks.ok} Recording · all events synced`);
  }
}
