/**
 * `adit snapshot diff <id>` — Show the diff for a checkpoint event.
 * `adit prompt <id>` — Show the prompt text for an event.
 * `adit snapshot env` — Show/compare environment snapshots.
 *
 * Every ID argument accepts the 10-character prefix other commands print.
 */

import { basename } from "node:path";
import {
  openDatabase,
  closeDatabase,
  getEnvSnapshotById,
  getLatestEnvSnapshot,
  getLatestSession,
  listEnvSnapshots,
  type EnvSnapshot,
} from "@varveai/adit-core";
import { loadInitializedProjectConfig } from "./project-initialization.js";
import { createTimelineManager, diffEnvironments } from "@varveai/adit-engine";
import {
  arrow,
  dim,
  formatCount,
  localDateTime,
  marks,
  outputStyle,
  plural,
  printEnd,
  printError,
  printLine,
  printRows,
  printTable,
  printTitle,
  shortenPaths,
  shortId,
  strong,
  truncate,
  type Row,
} from "./cli-style.js";
import { resolveLocalIdOrReport } from "./local-ids.js";

const EVENT_HINT = `find IDs with ${strong("adit timeline")}`;
const SNAPSHOT_HINT = `find IDs with ${strong("adit snapshot env history")}`;

export async function diffCommand(
  eventId: string,
  opts: { maxLines?: number; offsetLines?: number; file?: string },
): Promise<void> {
  const config = loadInitializedProjectConfig("adit snapshot diff");
  if (!config) return;
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    const id = resolveLocalIdOrReport(db, "events", eventId, "snapshot diff", EVENT_HINT);
    if (!id) return;
    let diff = await timeline.getDiff(id, opts.maxLines, opts.offsetLines);
    if (!diff) {
      printError("snapshot diff", `no diff recorded for event ${eventId}`, `only events that changed files carry a diff; see ${strong(`adit show ${eventId}`)}`);
      process.exitCode = 1;
      return;
    }

    // Filter to a specific file if requested
    if (opts.file) {
      diff = filterDiffByFile(diff, opts.file);
      if (!diff.trim()) {
        printError("snapshot diff", `no changes for ${opts.file} in event ${eventId}`, `list the files with ${strong(`adit show ${eventId}`)}`);
        process.exitCode = 1;
        return;
      }
    }

    // The raw unified diff, unframed, so it can be piped into patch tools.
    console.log(diff);
  } finally {
    closeDatabase(db);
  }
}

/** Extract diff hunks for a specific file from a unified diff */
function filterDiffByFile(diff: string, filePath: string): string {
  const lines = diff.split("\n");
  const result: string[] = [];
  let capturing = false;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      // Check if this diff section matches the requested file
      capturing =
        line.includes(`a/${filePath}`) || line.includes(`b/${filePath}`);
    }
    if (capturing) {
      result.push(line);
    }
  }

  return result.join("\n");
}

export async function promptCommand(
  eventId: string,
  opts?: { maxChars?: number; offset?: number },
): Promise<void> {
  const config = loadInitializedProjectConfig("adit prompt");
  if (!config) return;
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    const id = resolveLocalIdOrReport(db, "events", eventId, "prompt", EVENT_HINT);
    if (!id) return;
    const event = await timeline.get(id);
    if (!event) {
      printError("prompt", `event ${eventId} not found`, EVENT_HINT);
      process.exitCode = 1;
      return;
    }
    if (!event.promptText) {
      printError("prompt", `event ${eventId} has no prompt text (${event.eventType})`, `read the whole event with ${strong(`adit show ${eventId}`)}`);
      process.exitCode = 1;
      return;
    }

    const full = event.promptText;
    let text = full;
    const start = opts?.offset ?? 0;
    const end = opts?.maxChars ? start + opts.maxChars : full.length;
    if (start > 0 || opts?.maxChars) text = full.slice(start, end);
    const remaining = Math.max(0, full.length - end);

    // Pipes and agents get the text exactly as before; a terminal gets the frame.
    if (!outputStyle().rail) {
      console.log(remaining > 0 ? `${text}\n... (truncated, ${remaining} chars remaining)` : text);
      return;
    }

    printTitle("Prompt", shortId(event.id), localDateTime(event.startedAt, { seconds: true }), plural(full.length, "char"));
    printLine(text);
    if (remaining > 0) {
      printEnd(`${marks.skip} ${formatCount(remaining)} more chars · next: ${strong(`adit prompt ${shortId(event.id)} --offset ${end}${opts?.maxChars ? ` --max-chars ${opts.maxChars}` : ""}`)}`);
    } else {
      printEnd();
    }
  } finally {
    closeDatabase(db);
  }
}

/** Show environment snapshot for a specific event (legacy command) */
export async function envCommand(eventId: string): Promise<void> {
  const config = loadInitializedProjectConfig("adit snapshot env");
  if (!config) return;
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    const id = resolveLocalIdOrReport(db, "events", eventId, "snapshot env show", EVENT_HINT);
    if (!id) return;
    const event = await timeline.get(id);
    if (!event) {
      printError("snapshot env show", `event ${eventId} not found`, EVENT_HINT);
      process.exitCode = 1;
      return;
    }
    if (!event.envSnapshotId) {
      printError("snapshot env show", `event ${eventId} has no environment snapshot`, `snapshots are taken at checkpoints; see ${strong("adit snapshot env history")}`);
      process.exitCode = 1;
      return;
    }

    const snap = getEnvSnapshotById(db, event.envSnapshotId);
    if (!snap) {
      printError("snapshot env show", `environment snapshot ${event.envSnapshotId} not found`, SNAPSHOT_HINT);
      process.exitCode = 1;
      return;
    }

    printEnvSnapshot(snap, config.projectRoot);
  } finally {
    closeDatabase(db);
  }
}

/** `adit env latest` — show the most recent env snapshot for the active session */
export async function envLatestCommand(opts?: { json?: boolean }): Promise<void> {
  const config = loadInitializedProjectConfig("adit env latest");
  if (!config) return;
  const db = openDatabase(config.dbPath);

  try {
    const session = getLatestSession(db, config.projectId, config.clientId);
    if (!session) {
      printError("snapshot env latest", "no sessions recorded in this project yet", "start an AI session in this project first");
      process.exitCode = 1;
      return;
    }

    const snap = getLatestEnvSnapshot(db, session.id);
    if (!snap) {
      printError("snapshot env latest", "the latest session has no environment snapshot", "snapshots are taken at checkpoints during a session");
      process.exitCode = 1;
      return;
    }

    if (opts?.json) {
      console.log(JSON.stringify(snap, null, 2));
    } else {
      printEnvSnapshot(snap, config.projectRoot);
    }
  } finally {
    closeDatabase(db);
  }
}

/** `adit env diff <id1> <id2>` — compare two environment snapshots */
export async function envDiffCommand(
  id1: string,
  id2: string,
  opts?: { json?: boolean },
): Promise<void> {
  const config = loadInitializedProjectConfig("adit env diff");
  if (!config) return;
  const db = openDatabase(config.dbPath);

  try {
    const first = resolveLocalIdOrReport(db, "env_snapshots", id1, "snapshot env diff", SNAPSHOT_HINT);
    if (!first) return;
    const second = resolveLocalIdOrReport(db, "env_snapshots", id2, "snapshot env diff", SNAPSHOT_HINT);
    if (!second) return;
    const snap1 = getEnvSnapshotById(db, first);
    const snap2 = getEnvSnapshotById(db, second);
    if (!snap1 || !snap2) {
      printError("snapshot env diff", `snapshot ${snap1 ? id2 : id1} not found`, SNAPSHOT_HINT);
      process.exitCode = 1;
      return;
    }

    const diff = diffEnvironments(snap1, snap2);

    if (opts?.json) {
      console.log(JSON.stringify(diff, null, 2));
      return;
    }

    printTitle("Environment diff", `${shortId(snap1.id)} ${arrow()} ${shortId(snap2.id)}`);
    if (diff.changes.length === 0) {
      printEnd(`${marks.ok} No environment changes`);
      return;
    }
    printRows(
      diff.changes.map((change) => ({
        mark: change.severity === "breaking" ? marks.fail : change.severity === "warning" ? marks.warn : marks.change,
        label: `${change.category} ${change.field}`,
        value: `${truncate(change.oldValue ?? "(none)", 40)} ${dim(arrow())} ${truncate(change.newValue ?? "(none)", 40)}`,
      })),
    );
    const mark = diff.severity === "breaking" ? marks.fail : diff.severity === "warning" ? marks.warn : marks.change;
    printEnd(`${mark} ${plural(diff.changes.length, "change")}${diff.severity === "breaking" ? " · includes breaking changes" : ""}`);
  } finally {
    closeDatabase(db);
  }
}

/** `adit env history` — list env snapshots for the session */
export async function envHistoryCommand(
  opts?: { limit?: number; json?: boolean },
): Promise<void> {
  const config = loadInitializedProjectConfig("adit env history");
  if (!config) return;
  const db = openDatabase(config.dbPath);

  try {
    const session = getLatestSession(db, config.projectId, config.clientId);
    if (!session) {
      printError("snapshot env history", "no sessions recorded in this project yet", "start an AI session in this project first");
      process.exitCode = 1;
      return;
    }

    const snapshots = listEnvSnapshots(db, session.id, opts?.limit ?? 20);

    if (snapshots.length === 0) {
      if (opts?.json) {
        console.log("No environment snapshots found.");
        return;
      }
      printTitle("Environment history", basename(config.projectRoot), "latest session");
      printEnd(`${marks.skip} No environment snapshots in the latest session`);
      return;
    }

    if (opts?.json) {
      console.log(JSON.stringify(snapshots, null, 2));
      return;
    }

    const total = (db
      .prepare("SELECT COUNT(*) AS count FROM env_snapshots WHERE session_id = ? AND deleted_at IS NULL")
      .get(session.id) as { count: number } | undefined)?.count ?? snapshots.length;

    printTitle("Environment history", basename(config.projectRoot), `${snapshots.length} of ${total}`);
    printTable(
      [{ header: "id" }, { header: "captured" }, { header: "branch" }, { header: "node" }, { header: "modified", align: "right" }],
      snapshots.map((snap) => [
        shortId(snap.id),
        localDateTime(snap.capturedAt, { seconds: true }),
        knownOrDash(snap.gitBranch),
        snap.nodeVersion ?? "-",
        String(parseModified(snap.modifiedFiles).length),
      ]),
    );
    printEnd(
      total > snapshots.length
        ? dim(`${snapshots.length} of ${total} · more: ${strong(`adit snapshot env history --limit ${total}`)}`)
        : dim(`compare two: ${strong("adit snapshot env diff <id> <id>")}`),
    );
  } finally {
    closeDatabase(db);
  }
}

function knownOrDash(value: string | null | undefined): string {
  return !value || value === "unknown" ? "-" : value;
}

function parseModified(json: string | null): string[] {
  if (!json) return [];
  try {
    const files = JSON.parse(json) as unknown;
    return Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : [];
  } catch {
    return [];
  }
}

function parseObject<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** "ruby 2.6.10p210 (2022-04-12 ...)" -> "2.6.10p210"; anything unrecognized is shortened. */
function versionOf(raw: string, name: string): string {
  const withoutName = raw.replace(new RegExp(`^${name}\\s+`, "iu"), "").trim();
  const token = withoutName.split(/\s+/u).find((part) => /\d+\.\d+/u.test(part));
  return token ?? truncate(withoutName, 40);
}

/** Print a formatted env snapshot */
function printEnvSnapshot(snap: EnvSnapshot, projectRoot: string): void {
  const rows: Row[] = [
    { label: "Branch", value: knownOrDash(snap.gitBranch) },
    { label: "HEAD", value: knownOrDash(snap.gitHeadSha) === "-" ? "-" : shortId(snap.gitHeadSha) },
  ];
  if (snap.nodeVersion) rows.push({ label: "Node", value: snap.nodeVersion });
  if (snap.pythonVersion) rows.push({ label: "Python", value: versionOf(snap.pythonVersion, "python") });
  const runtimes = parseObject<Record<string, string>>(snap.runtimeVersionsJson);
  for (const [name, version] of Object.entries(runtimes ?? {})) {
    if (typeof version !== "string") continue;
    rows.push({ label: name.charAt(0).toUpperCase() + name.slice(1), value: versionOf(version, name) });
  }
  const shell = parseObject<{ shell?: string; version?: string }>(snap.shellInfo);
  if (shell?.shell) {
    const version = shell.version?.replace(/\s*\(.*\)\s*$/u, "").trim();
    rows.push({ label: "Shell", value: version ? `${shell.shell} (${version})` : shell.shell });
  }
  const resources = parseObject<{ arch?: string; cpuModel?: string; totalMem?: number }>(snap.systemResourcesJson);
  const os = [snap.osInfo, resources?.arch, resources?.cpuModel].filter((part): part is string => Boolean(part));
  if (os.length > 0) rows.push({ label: "OS", value: os.join(dim(" · ")) });
  if (typeof resources?.totalMem === "number" && resources.totalMem > 0) {
    rows.push({ label: "Memory", value: `${(resources.totalMem / 1024 ** 3).toFixed(1)} GB` });
  }
  const packageManager = parseObject<{ name?: string; version?: string }>(snap.packageManagerJson);
  if (packageManager?.name) rows.push({ label: "Pkg manager", value: `${packageManager.name}${packageManager.version ? ` ${packageManager.version}` : ""}` });
  if (snap.depLockPath) rows.push({ label: "Lock file", value: `${snap.depLockPath}${snap.depLockHash ? dim(` · ${snap.depLockHash.slice(0, 12)}`) : ""}` });
  const container = parseObject<{ inDocker?: boolean; image?: string }>(snap.containerInfo);
  if (container) rows.push({ label: "Container", value: container.inDocker ? `Docker${container.image ? ` (${container.image})` : ""}` : "none" });
  if (snap.modifiedFiles !== null) {
    const files = parseModified(snap.modifiedFiles);
    const listed = files.slice(0, 10).map((file) => shortenPaths(file, projectRoot));
    const more = files.length - listed.length;
    rows.push({
      label: "Modified",
      value: [plural(files.length, "file"), ...listed, ...(more > 0 ? [dim(`and ${more} more`)] : [])].join("\n"),
    });
  }

  printTitle("Environment", shortId(snap.id), localDateTime(snap.capturedAt, { seconds: true }));
  printRows(rows);
  printEnd(dim(`history: ${strong("adit snapshot env history")}`));
}
