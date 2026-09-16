/**
 * Working-tree snapshots around shell tool calls (Claude's Bash tool,
 * Codex's exec_command — both reported to hooks as tool_name "Bash").
 *
 * Editing tools name the file they touch, but a shell command can rewrite
 * any number of files (python heredocs, `cat >`, `sed -i`, generated
 * scripts) without naming them. To still learn which files a turn changed,
 * PreToolUse(Bash) records the working tree of every project repository as
 * a git tree object, PostToolUse(Bash) records it again, and the tree diff
 * is the list of files that changed while the command ran.
 *
 * Guarantees and limits:
 *  - The user's real index is never touched: `git add -A` runs against a
 *    temporary copy of the index (which keeps git's stat cache, so unchanged
 *    files are not re-hashed). The temporary tree objects are unreachable and
 *    get garbage-collected by git.
 *  - Result is path-level evidence only ("inferred"), never a diff. Anything
 *    else writing to the same checkout during the command is indistinguishable
 *    from the command's own writes.
 *  - Commands that move HEAD (checkout, pull, reset) are skipped: the files a
 *    branch switch touches are not the agent's edits.
 *  - Background commands are skipped by the caller: their hooks fire before
 *    the command finishes, so no window exists to snapshot.
 *
 * Snapshots live under `<dataDir>/bash-snapshots/<localSessionId>/` between
 * the two hooks; the stop hook drains them into the turn's event.
 */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { runGit } from "@varveai/adit-engine";
import type { AgentFileMutation, MutationKind, MutationOmitted } from "../mutations/types.js";
import { MAX_EVENT_DIFF_BYTES, MAX_FILE_DIFF_BYTES, utf8ByteLength } from "../mutations/constants.js";

export type InferredFileStatus = "A" | "M" | "D" | "R";

export interface InferredFileChange {
  /** Project-root-relative path (forward slashes). */
  path: string;
  status: InferredFileStatus;
  /** Previous path for renames. */
  oldPath?: string;
  additions?: number;
  deletions?: number;
  /** Unified diff hunks (no `diff --git`/---/+++ header), bounded by MAX_FILE_DIFF_BYTES. */
  diff?: string;
  omitted?: MutationOmitted;
}

export interface RepositoryTreeSnapshot {
  localRepositoryId: string;
  /** Repository path relative to the project root ("." for the root repo). */
  relativePath: string;
  /** Absolute repository path. */
  path: string;
  /** Tree object of the working tree at capture time. */
  tree: string;
  /** HEAD commit at capture time (null on an unborn branch). */
  head: string | null;
}

export interface ToolSnapshot {
  toolUseId: string;
  promptId: string | null;
  startedAt: string;
  repositories: RepositoryTreeSnapshot[];
}

export interface PendingInferredEntry {
  toolUseId: string;
  promptId: string | null;
  recordedAt: string;
  files: InferredFileChange[];
}

/** Platforms whose shell tool calls are snapshotted. */
export type SnapshotProvider = "claude-code" | "claude-vscode" | "codex" | "cursor";

/** Source marker carried by every inferred entry, per platform. */
export type InferredFileSource = "claude-bash-snapshot" | "codex-bash-snapshot" | "cursor-bash-snapshot";

/** One entry of events.inferred_files_json. */
export interface InferredFileRecord {
  path: string;
  status: InferredFileStatus;
  oldPath?: string;
  source: InferredFileSource;
  toolUseId: string;
}

export const INFERRED_FILE_SOURCE = "claude-bash-snapshot" as const;

export function inferredSourceFor(provider: SnapshotProvider): InferredFileSource {
  if (provider === "cursor") return "cursor-bash-snapshot";
  return provider === "codex" ? "codex-bash-snapshot" : INFERRED_FILE_SOURCE;
}

/** Upper bound on persisted entries per turn (runaway guard). */
export const MAX_INFERRED_FILES_PER_TURN = 2000;

/**
 * Per-git-command budget. PreToolUse blocks the agent, and the hook process
 * self-kills at 10s, so a slow repository must degrade to "no snapshot"
 * rather than stall the tool call.
 */
const GIT_TIMEOUT_MS = 4000;

export interface WorkingTreeCapture {
  tree: string;
  head: string | null;
}

/**
 * Record the working tree of `repoPath` as a git tree object, using a
 * temporary index so the user's staging area is untouched. Returns null
 * when the directory is not a git repository or git fails/times out.
 */
export async function captureWorkingTree(repoPath: string): Promise<WorkingTreeCapture | null> {
  const indexPathResult = await runGit(["rev-parse", "--git-path", "index"], {
    cwd: repoPath,
    timeout: GIT_TIMEOUT_MS,
  });
  if (indexPathResult.exitCode !== 0) return null;
  const indexPath = resolve(repoPath, indexPathResult.stdout.trim());

  const tempIndex = join(tmpdir(), `adit-index-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    try {
      copyFileSync(indexPath, tempIndex);
      // Keep the original index mtime on the copy. Git decides whether a
      // cached stat can be trusted by comparing an entry's mtime with the
      // index file's mtime ("racy git"): a file rewritten in the same second
      // the index recorded it, with the same size, is only re-hashed when the
      // entry is not older than the index. A fresh copy timestamp would mark
      // every entry as safely older and silently miss such rewrites.
      const original = statSync(indexPath);
      utimesSync(tempIndex, original.atime, original.mtime);
    } catch {
      // No index yet (fresh repository) — git creates the temp index from scratch.
    }
    const env = { GIT_INDEX_FILE: tempIndex };
    const add = await runGit(
      ["-c", "advice.addEmbeddedRepo=false", "add", "-A", "--ignore-errors", "--", "."],
      { cwd: repoPath, env, timeout: GIT_TIMEOUT_MS },
    );
    if (add.exitCode !== 0) return null;
    const writeTree = await runGit(["write-tree"], { cwd: repoPath, env, timeout: GIT_TIMEOUT_MS });
    if (writeTree.exitCode !== 0) return null;
    const tree = writeTree.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/u.test(tree)) return null;

    const headResult = await runGit(["rev-parse", "--verify", "-q", "HEAD"], {
      cwd: repoPath,
      timeout: GIT_TIMEOUT_MS,
    });
    const head = headResult.exitCode === 0 ? headResult.stdout.trim() || null : null;
    return { tree, head };
  } finally {
    for (const file of [tempIndex, `${tempIndex}.lock`]) {
      try { unlinkSync(file); } catch { /* already gone */ }
    }
  }
}

/**
 * Files whose content differs between two tree objects, as repository-
 * relative paths. Renames are detected; type changes count as modifications.
 */
export async function diffWorkingTrees(
  repoPath: string,
  beforeTree: string,
  afterTree: string,
): Promise<InferredFileChange[]> {
  if (beforeTree === afterTree) return [];
  const result = await runGit(
    ["diff-tree", "-r", "-M", "--name-status", "-z", beforeTree, afterTree],
    { cwd: repoPath, timeout: GIT_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) return [];
  return parseNameStatusZ(result.stdout);
}

/**
 * Like diffWorkingTrees, but also attaches each file's unified diff hunks
 * and +/- counts, so Bash-driven changes carry the same evidence as
 * editing-tool mutations. Bodies are bounded per file (MAX_FILE_DIFF_BYTES)
 * and per command (MAX_EVENT_DIFF_BYTES); files past a bound keep their
 * path and status with `omitted` set. Binary files are omitted as well.
 */
export async function diffWorkingTreesWithPatch(
  repoPath: string,
  beforeTree: string,
  afterTree: string,
): Promise<InferredFileChange[]> {
  const changes = await diffWorkingTrees(repoPath, beforeTree, afterTree);
  if (changes.length === 0) return changes;

  const patch = await runGit(
    [
      "-c", "core.quotePath=false",
      "diff-tree", "-r", "-M", "-p", "--no-color", "--no-ext-diff", "--no-prefix",
      beforeTree, afterTree,
    ],
    { cwd: repoPath, timeout: GIT_TIMEOUT_MS },
  );
  const bodies = patch.exitCode === 0 ? parsePatchBodies(patch.stdout) : new Map<string, PatchBody>();

  let budget = MAX_EVENT_DIFF_BYTES;
  for (const change of changes) {
    const body = bodies.get(change.path);
    if (!body) {
      change.omitted = { reason: "unavailable" };
      continue;
    }
    if (body.binary) {
      change.omitted = { reason: "unavailable" };
      continue;
    }
    const bytes = utf8ByteLength(body.diff);
    const stats = countDiffLines(body.diff);
    change.additions = stats.additions;
    change.deletions = stats.deletions;
    if (bytes > MAX_FILE_DIFF_BYTES) {
      change.omitted = { reason: "diff_too_large", bytes, limitBytes: MAX_FILE_DIFF_BYTES };
      continue;
    }
    if (bytes > budget) {
      change.omitted = { reason: "diff_too_large", bytes, limitBytes: MAX_EVENT_DIFF_BYTES };
      continue;
    }
    budget -= bytes;
    change.diff = body.diff;
  }
  return changes;
}

interface PatchBody {
  diff: string;
  binary: boolean;
}

/**
 * Split `git diff-tree -p --no-prefix` output into per-file hunk bodies keyed
 * by the file's (new) repository-relative path. Header lines up to and
 * including `+++` are dropped; pure renames without content change yield an
 * empty body.
 */
export function parsePatchBodies(output: string): Map<string, PatchBody> {
  const bodies = new Map<string, PatchBody>();
  const segments = output.split(/^(?=diff --git )/mu);
  for (const segment of segments) {
    if (!segment.startsWith("diff --git ")) continue;
    const lines = segment.split("\n");
    let path: string | null = null;
    let bodyStart = lines.length;
    let binary = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("+++ ")) {
        const target = line.slice(4);
        if (target !== "/dev/null") path = target;
        bodyStart = i + 1;
        break;
      }
      if (line.startsWith("--- ") && line.slice(4) !== "/dev/null") {
        // Deletions have `--- old` followed by `+++ /dev/null`.
        path = path ?? line.slice(4);
        continue;
      }
      if (line.startsWith("rename to ")) { path = line.slice("rename to ".length); continue; }
      if (line.startsWith("copy to ")) { path = line.slice("copy to ".length); continue; }
      if (line.startsWith("Binary files ")) { binary = true; bodyStart = lines.length; break; }
      if (line.startsWith("@@")) { bodyStart = i; break; }
    }
    if (!path) {
      // No ---/+++ and no rename line (e.g. a pure mode change): the header
      // is `diff --git <path> <path>`; take the trailing half.
      const header = lines[0].slice("diff --git ".length);
      path = header.slice(Math.ceil(header.length / 2)) || null;
    }
    if (!path) continue;
    const body = lines.slice(bodyStart).join("\n").replace(/\n$/u, "");
    bodies.set(path, { diff: body, binary });
  }
  return bodies;
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/** Parse `git diff-tree --name-status -z` output. */
export function parseNameStatusZ(output: string): InferredFileChange[] {
  const fields = output.split("\0");
  const changes: InferredFileChange[] = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i];
    if (!status) { i++; continue; }
    const code = status[0];
    if (code === "R" || code === "C") {
      const oldPath = fields[i + 1];
      const newPath = fields[i + 2];
      i += 3;
      if (!oldPath || !newPath) continue;
      if (code === "R") changes.push({ path: newPath, status: "R", oldPath });
      else changes.push({ path: newPath, status: "A" });
      continue;
    }
    const path = fields[i + 1];
    i += 2;
    if (!path) continue;
    if (code === "A") changes.push({ path, status: "A" });
    else if (code === "D") changes.push({ path, status: "D" });
    else if (code === "M" || code === "T") changes.push({ path, status: "M" });
    // U (unmerged) and X (unknown) carry no attributable change.
  }
  return changes;
}

/**
 * Re-key repository-relative changes to project-root-relative paths and
 * drop anything under ADIT's own data directory.
 */
export function toProjectRelativeChanges(
  changes: InferredFileChange[],
  opts: { repositoryRelativePath: string; projectRoot: string; dataDir: string },
): InferredFileChange[] {
  const repoPrefix = normalizeRelative(opts.repositoryRelativePath);
  const dataDirRel = normalizeRelative(relative(resolve(opts.projectRoot), resolve(opts.dataDir)));
  const insideDataDir = (path: string): boolean =>
    dataDirRel !== "" && !dataDirRel.startsWith("..") && !isAbsolute(dataDirRel) &&
    (path === dataDirRel || path.startsWith(`${dataDirRel}/`));
  const rekey = (path: string): string =>
    repoPrefix === "" ? path : posix.join(repoPrefix, path);

  const result: InferredFileChange[] = [];
  for (const change of changes) {
    const path = rekey(change.path.replace(/\\/gu, "/"));
    if (insideDataDir(path)) continue;
    const entry: InferredFileChange = { ...change, path };
    if (change.oldPath) entry.oldPath = rekey(change.oldPath.replace(/\\/gu, "/"));
    result.push(entry);
  }
  return result;
}

function normalizeRelative(path: string): string {
  const slashed = path.replace(/\\/gu, "/").replace(/^\.\/+/u, "").replace(/\/+$/u, "");
  return slashed === "." ? "" : slashed;
}

// ---------------------------------------------------------------------------
// Snapshot store (between PreToolUse, PostToolUse and Stop)
// ---------------------------------------------------------------------------

const PENDING_FILE = "pending.jsonl";

export function snapshotSessionDir(dataDir: string, sessionId: string): string {
  return join(dataDir, "bash-snapshots", safeName(sessionId));
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 200) || "_";
}

function toolSnapshotPath(dataDir: string, sessionId: string, toolUseId: string): string {
  return join(snapshotSessionDir(dataDir, sessionId), `${safeName(toolUseId)}.json`);
}

export function writeToolSnapshot(dataDir: string, sessionId: string, snapshot: ToolSnapshot): void {
  const dir = snapshotSessionDir(dataDir, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(toolSnapshotPath(dataDir, sessionId, snapshot.toolUseId), JSON.stringify(snapshot));
}

/** Read and remove the PreToolUse snapshot for a tool call, if any. */
export function takeToolSnapshot(dataDir: string, sessionId: string, toolUseId: string): ToolSnapshot | null {
  const file = toolSnapshotPath(dataDir, sessionId, toolUseId);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ToolSnapshot;
    return parsed && Array.isArray(parsed.repositories) ? parsed : null;
  } catch {
    return null;
  } finally {
    try { unlinkSync(file); } catch { /* best-effort */ }
  }
}

export function appendPendingInferred(dataDir: string, sessionId: string, entry: PendingInferredEntry): void {
  const dir = snapshotSessionDir(dataDir, sessionId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, PENDING_FILE), JSON.stringify(entry) + "\n");
}

/**
 * Read every pending entry recorded for the session and remove the whole
 * snapshot directory, including PreToolUse snapshots whose PostToolUse never
 * fired (denied or cancelled commands).
 */
export function takePendingInferred(dataDir: string, sessionId: string): PendingInferredEntry[] {
  const dir = snapshotSessionDir(dataDir, sessionId);
  if (!existsSync(dir)) return [];
  const entries: PendingInferredEntry[] = [];
  try {
    const pendingFile = join(dir, PENDING_FILE);
    if (existsSync(pendingFile)) {
      for (const line of readFileSync(pendingFile, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as PendingInferredEntry;
          if (parsed && typeof parsed.toolUseId === "string" && Array.isArray(parsed.files)) {
            entries.push(parsed);
          }
        } catch {
          // skip malformed line
        }
      }
    }
  } finally {
    clearSessionSnapshots(dataDir, sessionId);
  }
  return entries;
}

/** Drop everything recorded for the session (a new turn started, or the turn ended). */
export function clearSessionSnapshots(dataDir: string, sessionId: string): void {
  const dir = snapshotSessionDir(dataDir, sessionId);
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Turn-level merge
// ---------------------------------------------------------------------------

function kindFromStatus(status: InferredFileStatus): MutationKind {
  switch (status) {
    case "A": return "add";
    case "D": return "delete";
    case "R": return "rename";
    default: return "update";
  }
}

/**
 * Turn queued per-command changes into file mutations, one per (command,
 * file), so they flow through the same diff_stat/diff_text pipeline as
 * editing-tool mutations. Downstream treats sourced entries as incremental,
 * so two commands rewriting the same file simply add up.
 */
export function pendingToMutations(
  entries: PendingInferredEntry[],
  provider: SnapshotProvider,
): AgentFileMutation[] {
  const source = inferredSourceFor(provider);
  const mutations: AgentFileMutation[] = [];
  for (const entry of entries) {
    for (const change of entry.files) {
      if (!change.path) continue;
      const m: AgentFileMutation = {
        provider,
        toolUseId: entry.toolUseId,
        toolName: "Bash",
        path: change.path,
        kind: kindFromStatus(change.status),
        status: "completed",
        source,
      };
      if (typeof change.additions === "number") m.additions = change.additions;
      if (typeof change.deletions === "number") m.deletions = change.deletions;
      if (typeof change.diff === "string") m.diff = change.diff;
      else m.omitted = change.omitted ?? { reason: "unavailable" };
      mutations.push(m);
    }
  }
  return mutations;
}

/**
 * Collapse per-command changes into one entry per path for the turn.
 * Later commands win, with the natural compositions: created-then-deleted
 * vanishes, created-then-modified stays "A", deleted-then-recreated is "M".
 * Paths already covered by direct tool evidence (`exclude`) are dropped.
 */
export function mergeInferredFiles(
  entries: PendingInferredEntry[],
  opts: { exclude?: Iterable<string>; maxEntries?: number; source?: InferredFileSource } = {},
): InferredFileRecord[] {
  const source = opts.source ?? INFERRED_FILE_SOURCE;
  const exclude = new Set(opts.exclude ?? []);
  const maxEntries = opts.maxEntries ?? MAX_INFERRED_FILES_PER_TURN;
  const merged = new Map<string, InferredFileRecord>();

  for (const entry of entries) {
    for (const change of entry.files) {
      const path = change.path;
      if (!path) continue;
      if (change.status === "R" && change.oldPath) merged.delete(change.oldPath);
      const previous = merged.get(path);
      let status: InferredFileStatus = change.status;
      if (previous) {
        if (previous.status === "A" && change.status === "D") { merged.delete(path); continue; }
        if (previous.status === "A" && change.status === "M") status = "A";
        if (previous.status === "D" && change.status === "A") status = "M";
        if (previous.status === "R" && change.status === "M") status = "R";
      }
      const record: InferredFileRecord = {
        path,
        status,
        source,
        toolUseId: entry.toolUseId,
      };
      const oldPath = status === "R" ? (change.oldPath ?? previous?.oldPath) : undefined;
      if (oldPath) record.oldPath = oldPath;
      merged.set(path, record);
    }
  }

  return Array.from(merged.values())
    .filter((record) => !exclude.has(record.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, maxEntries);
}
