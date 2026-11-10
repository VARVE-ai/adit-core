import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve, isAbsolute, basename, relative } from "node:path";
import {
  LocalStore,
  createAttributionSchema,
  ATTRIBUTION_RESULT_TABLES,
  insideDirectory,
  analyticsSessions,
  projectSessionLocations,
  type LocalWorkspace,
} from "@varveai/adit-core";
import {
  normalizeLine,
  eligibleLine,
  extractWritten,
} from "./attribution-evidence.js";
import { AttributionSummaries, type AttributionLine, type AttributionCandidate } from "./attribution-summaries.js";
import { commandOf } from "./submission-evidence.js";
import { attributionNeeded, collectedCommits, fileAttributionCorrections, rememberSubmissionRevision, savedRun, submissionRevision } from "./attribution-plan.js";
import { callIdentities, readSubmissionCandidates, writeCalls } from "./attribution-input.js";
import { AttributionEvidenceStore, type AttributionEvidence as Evidence } from "./attribution-evidence-store.js";
import { resumableCommits, copyResumedCommits, pruneResumedRuns, type CommitInput } from "./attribution-resume.js";
import { AttributionGitObjects } from "./attribution-git-objects.js";
import { AttributionParentIndex } from "./attribution-parent-index.js";
import { AttributionTimer, type AttributionTiming, type AttributionCommitTimer, type CommitTiming } from "./attribution-timing.js";
import { AttributionDiffReader, ATTRIBUTION_FILE_LIMIT } from "./attribution-diff.js";
import { AttributionMatchIndex, type AttributionMatch } from "./attribution-match-index.js";
const execute = promisify(execFile);
export const ATTRIBUTION_VERSION = 5;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Row = Record<string, any>;
type AddedLine = {
  path: string;
  number: number;
  hunk: number;
  text: string;
  excluded: boolean;
};
const key = (provider: string, id: string) => provider + "\0" + id;
const generated = (path: string) =>
  /(?:^|\/)(?:node_modules|dist|build|vendor|migrations|__snapshots__|tmp|\.cache|coverage)(?:\/|$)|(?:\.lock|lock\.json|\.snap|\.min\.\w+|\.map|\.log|\.tsbuildinfo)$|(?:^|\/)(?:pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$/.test(
    path,
  );
const gitSourcePaths = [
  ".",
  ...[
    "node_modules",
    "dist",
    "build",
    "vendor",
    "migrations",
    "__snapshots__",
    "tmp",
    ".cache",
    "coverage",
  ].map((dir) => `:(exclude,glob)**/${dir}/**`),
  ...[
    "*.log",
    "*.map",
    "*.lock",
    "*.snap",
    "*.tsbuildinfo",
    "*.min.*",
    "pnpm-lock.yaml",
    "package-lock.json",
  ].map((file) => `:(exclude,glob)**/${file}`),
];

// This equivalence map exists only in memory for a single analysis. No native session is changed.
export function analysisIdentities(sessions: Row[], calls: Iterable<Row>) {
  const parent = new Map(
    sessions.map((s) => [key(s.provider, s.id), key(s.provider, s.id)]),
  );
  const find = (id: string): string => {
    const p = parent.get(id);
    if (!p || p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent.set(b, a);
  };
  const seen = new Map<string, string>();
  for (const call of calls) {
    if (!call.source_call_id) continue;
    const id = key(call.provider, call.session_id),
      native = key(call.provider, call.source_call_id);
    const old = seen.get(native);
    if (old) union(old, id);
    else seen.set(native, id);
  }
  // Native continuation pages and child work share the parent identity for analysis.
  // Actual forks remain independent unless copied calls establish equivalence.
  for (const s of sessions)
    if (
      s.parent_id &&
      ["subagent","continuation"].includes(s.relationship) &&
      parent.has(key(s.provider, s.parent_id))
    )
      union(key(s.provider, s.parent_id), key(s.provider, s.id));
  const groups = new Map<string, Row[]>();
  for (const s of sessions) {
    const root = find(key(s.provider, s.id));
    const group = groups.get(root) || [];
    group.push(s);
    groups.set(root, group);
  }
  const representatives = new Map<string, Row>();
  for (const [root, group] of groups)
    representatives.set(
      root,
      group.sort(
        (a, b) =>
          Number(["subagent","continuation"].includes(a.relationship)) -
            Number(["subagent","continuation"].includes(b.relationship)) ||
          (a.started_at ?? Infinity) - (b.started_at ?? Infinity) ||
          a.id.localeCompare(b.id),
      )[0],
    );
  return {
    find,
    representative: (id: string) => representatives.get(find(id))!,
  };
}

function inputMetadata(store: LocalStore, workspace: LocalWorkspace) {
  const db = store.db;
  return db.transaction(() => {
    const scopedSessions = analyticsSessions(db, workspace).filter(session => workspace.providers.includes(session.provider));
    const scopes = new Map(scopedSessions.map(session => [key(session.provider, session.id), session.cwd]));
    const scope = JSON.stringify(scopedSessions.map(session => [session.provider, session.id]));
    const locations = projectSessionLocations(db, workspace);
    const sessions = (
      db
        .prepare(
          `SELECT s.* FROM adit_history_sessions s WHERE (s.provider,s.id) IN (
            SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)
          ) ORDER BY s.rowid`,
        )
        .all(scope) as Row[]
    ).map((session): Row => ({
      ...session,
      scope_cwd: scopes.get(key(session.provider, session.id))!,
      original_root: locations.get(key(session.provider, session.id))?.original_root,
    }));
    const commits = collectedCommits(store, workspace);
    const sources = db.prepare(
      `SELECT provider,session_id,path,fingerprint FROM adit_history_sources
        WHERE provider='claude' AND (provider,session_id) IN (
          SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)
        ) ORDER BY rowid`,
    ).all(scope) as Row[];
    const evidenceRevision = digest([ATTRIBUTION_VERSION, workspace.path, workspace.providers, workspace.repositories, sessions, sources]);
    const fingerprint = digest([
      ATTRIBUTION_VERSION,
      workspace.path,
      workspace.providers,
      workspace.repositories,
      sessions.map((session) => [session.provider, session.id, session.transcript_revision]),
      commits.map((commit) => [commit.repository, commit.sha, commit.committed_at, commit.authored_at]),
      sources,
    ]);
    return { sessions, commits, sources, fingerprint, evidenceRevision, locations, scope };
  })();
}

export function parseAddedLines(patch: string): AddedLine[] {
  const result: AddedLine[] = [];
  let path = "",
    lineNumber = 0,
    hunk = 0,
    inside = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      path = "";
      inside = false;
    } else if (line.startsWith("+++ ")) {
      let value = line.slice(4).replace(/\r$/, "");
      if (value.startsWith('"'))
        try {
          value = JSON.parse(value);
        } catch {
          value = "";
        }
      path = value.startsWith("b/") ? value.slice(2) : "";
    } else if (line.startsWith("@@")) {
      const m = /\+(\d+)/.exec(line);
      lineNumber = m ? Number(m[1]) : 0;
      hunk++;
      inside = true;
    } else if (inside && path) {
      if (line.startsWith("+")) {
        const text = normalizeLine(line.slice(1));
        result.push({
          path,
          number: lineNumber++,
          hunk,
          text,
          excluded: generated(path) || !eligibleLine(text),
        });
      } else if (line.startsWith(" ")) lineNumber++;
    }
  }
  return result;
}

async function git(repository: string, args: string[], signal?: AbortSignal) {
  return (
    await execute("git", ["--no-pager", ...args], {
      cwd: repository,
      windowsHide: true,
      encoding: "utf8",
      timeout: 60000,
      // Large patches fall back to file-path association in AttributionDiffReader.
      maxBuffer: ATTRIBUTION_FILE_LIMIT,
      signal,
    })
  ).stdout;
}
function workingLocations(cwd: string, script: string): string[] {
  const locations = [cwd];
  for (const m of script.matchAll(
    /(?:\b(?:workdir|cwd)["']?\s*:\s*|\bgit\s+-C\s+|\bcd\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g,
  ))
    locations.unshift(m[1] || m[2] || m[3]);
  return locations
    .filter(Boolean)
    .map((location) =>
      isAbsolute(location) ? resolve(location) : resolve(cwd, location),
    );
}
function repositoryFor(
  w: LocalWorkspace,
  cwd: string,
  script = "",
  originalRoot?: string,
): string | null {
  for (const location of workingLocations(cwd, script)) {
    const absolute = relocateEvidencePath(w,location,originalRoot);
    const repo = w.repositories
      .filter((r) => insideDirectory(r, absolute))
      .sort((a, b) => b.length - a.length)[0];
    if (repo) return repo;
  }
  return null;
}
function relocateEvidencePath(w: LocalWorkspace, path: string, originalRoot?: string) {
  return originalRoot && !insideDirectory(w.path,path) && insideDirectory(originalRoot,path) ? resolve(w.path,relative(originalRoot,path)) : path;
}

function writeLocation(
  w: LocalWorkspace,
  cwd: string,
  command: string,
  path: string | null,
  originalRoot?: string,
) {
  // Explicit write targets take precedence over a session opened at the workspace
  // root or a wrapper that happens to execute commands in several repositories.
  const repository = repositoryFor(w, cwd, command,originalRoot);
  if (!path) return { filePath: null, repository };
  const filePath = relocateEvidencePath(w,isAbsolute(path)
    ? resolve(path)
    : resolve(workingLocations(cwd, command)[0] || cwd, path),originalRoot);
  return { filePath, repository: repositoryFor(w, filePath) };
}

function normalizedPath(value: string): string {
  const path = resolve(value);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

async function backupEvidence(
  snapshot: ReturnType<typeof inputMetadata>,
  w: LocalWorkspace,
  add: (source: Omit<Evidence, "id" | "text" | "group">, text: string) => void,
  relevant: (repository: string | null, filePath: string | null) => boolean,
  signal?: AbortSignal,
) {
  let missing = 0;
  const manifest: unknown[] = [];
  for (const source of snapshot.sources) {
    try {
      const info = await stat(source.path);
      if (info.size > 128 * 1024 * 1024) {
        missing++;
        continue;
      }
    } catch {
      missing++;
      continue;
    }
    const session = snapshot.sessions.find(
      (s) => s.provider === source.provider && s.id === source.session_id,
    )!;
    // Derive the Claude home from the recorded projects directory, including configured custom homes.
    let root = dirname(source.path);
    while (basename(root) !== "projects" && dirname(root) !== root)
      root = dirname(root);
    if (basename(root) !== "projects") continue;
    const home = dirname(root);
    const previous = new Map<string, { text: string; at: number }>();
    const input = createReadStream(source.path, { encoding: "utf8" });
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
    for await (const line of reader) {
      signal?.throwIfAborted();
      if (!line.includes("file-history-snapshot")) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const snap = row.snapshot;
      if (!snap?.trackedFileBackups) continue;
      for (const [file, entry] of Object.entries(snap.trackedFileBackups) as [
        string,
        any,
      ][]) {
        const name = entry.backupFileName;
        if (typeof name !== "string") continue;
        const location = writeLocation(w, session.scope_cwd, "", file, session.original_root);
        if (!relevant(location.repository, location.filePath)) continue;
        // Native backup names must stay under this session's file-history directory.
        const dir = join(home, "file-history", source.session_id),
          path = resolve(dir, name);
        if (!insideDirectory(dir, path)) continue;
        try {
          const info = await stat(path);
          manifest.push([path, info.size, info.mtimeMs]);
          if (info.size > 8 * 1024 * 1024) {
            missing++;
            continue;
          }
          const content = await readFile(path, "utf8"),
            at = Date.parse(
              entry.backupTime || snap.timestamp || row.timestamp || "",
            );
          if (!Number.isFinite(at)) {
            missing++;
            continue;
          }
          const old = previous.get(file);
          if (old && at > old.at) {
            const oldLines = new Set(old.text.split("\n").map(normalizeLine));
            const added = content
              .split("\n")
              .filter((l) => !oldLines.has(normalizeLine(l)))
              .join("\n");
            add(
              {
                provider: source.provider,
                sessionId: source.session_id,
                turnId: null,
                toolId: null,
                kind: "claude_backup",
                sourcePath: path,
                filePath: location.filePath,
                at,
                repository: location.repository,
              },
              added,
            );
          }
          previous.set(file, { text: content, at });
        } catch (error) {
          if (String((error as { code?: string }).code).startsWith("SQLITE_")) throw error;
          missing++;
          manifest.push([path, "missing"]);
        }
      }
    }
    } catch (error) {
      if (signal?.aborted || String((error as { code?: string }).code).startsWith("SQLITE_")) throw error;
      missing++;
    } finally {
      reader.close();
      input.destroy();
    }
  }
  return { missing, manifest };
}

type AnalysisOptions = {
  signal?: AbortSignal;
  force?: boolean;
  recheck?: { repository: string; sha: string }[];
  progress?: (repository: string) => void;
  timing?: (event: AttributionTiming) => void;
  traceCommits?: boolean;
};

export async function analyzeAttribution(
  store: LocalStore,
  w: LocalWorkspace,
  options: AnalysisOptions = {},
) {
  const timer = new AttributionTimer(options.timing, options.traceCommits);
  try {
    const result = await runAttribution(store, w, options, timer);
    timer.finish(result.cached ? "unchanged" : "done");
    return result;
  } catch (error) {
    timer.finish(options.signal?.aborted ? "cancelled" : "failed");
    throw error;
  }
}

async function runAttribution(
  store: LocalStore,
  w: LocalWorkspace,
  options: AnalysisOptions,
  timer: AttributionTimer,
) {
  createAttributionSchema(store.db);
  const db = store.db;
  options.signal?.throwIfAborted();
  if (!options.force && !options.recheck?.length && !attributionNeeded(store, w))
    return { id: savedRun(store, w.id)?.id ?? null, cached: true };
  // New SHAs and explicit rechecks recompute code provenance. Late submission
  // evidence may fill an empty link without rewriting saved line attribution.
  const { previous, analyzed, recheckTargets } = db.transaction(() => {
    const previous = savedRun(store, w.id);
    const commits = collectedCommits(store, w);
    for (const target of options.recheck || [])
      if (
        !commits.some(
          (c) => c.repository === target.repository && c.sha === target.sha,
        )
      )
        throw new Error(
          "Cannot recheck a commit outside the collected workspace",
        );
    const analyzed = new Set(
      previous && !options.force
        ? (
            db
              .prepare(
                "SELECT repository,sha FROM adit_attribution_commits WHERE run_id=?",
              )
              .all(previous.id) as Row[]
          ).map((c) => key(c.repository, c.sha))
        : [],
    );
    const collected = new Set(commits.map(commit => key(commit.repository, commit.sha)));
    const corrections = previous && !options.force ? fileAttributionCorrections(store, previous.id)
      .filter(commit => collected.has(key(commit.repository, commit.sha))) : [];
    const recheckTargets = [...new Map([...(options.recheck || []), ...corrections]
      .map(commit => [key(commit.repository, commit.sha), commit])).values()];
    for (const target of recheckTargets)
      analyzed.delete(key(target.repository, target.sha));
    return {
      previous,
      analyzed,
      recheckTargets,
    };
  })();
  const snapshot = inputMetadata(store, w),
    identities = analysisIdentities(snapshot.sessions, callIdentities(store, snapshot.scope));
  const submissionInputRevision = submissionRevision(store, w);
  const rechecks = new Set(recheckTargets.map(c => key(c.repository, c.sha)));
  let targets = snapshot.commits.filter(
    (c) => !analyzed.has(key(c.repository, c.sha)),
  );
  timer.phase("submissions");
  const operations = readSubmissionCandidates(store, snapshot.scope).map(e => {
    const session = snapshot.sessions.find(s => s.provider === e.call.provider && s.id === e.call.session_id)!;
    return { ...e, group: identities.find(key(e.call.provider, e.call.session_id)),
      repository: e.batch ? null : repositoryFor(w, e.cwd || e.call.working_directory || session.scope_cwd, e.command, session.original_root) };
  });
  const matchSubmission = (commit: Row) => {
    const at = commit.committed_at ?? commit.authored_at;
    const compatible = operations.filter(
      (o) => !o.repository || o.repository === commit.repository,
    );
    let method: string | null = "hash";
    let matches = compatible.filter((o) =>
      o.hashes.some(
        (hash) =>
          commit.sha.startsWith(hash) &&
          snapshot.commits.filter(
            (c) =>
              c.repository === commit.repository && c.sha.startsWith(hash),
          ).length === 1,
      ),
    );
    let matchedSha: string | null = null;
    if (!matches.length) {
      method = "subject_time";
      matches = compatible.filter(
        (o) =>
          o.repository === commit.repository &&
          o.subjects.includes(commit.subject) &&
          o.call.occurred_at !== null &&
          at !== null &&
          Math.abs(o.call.occurred_at - at) <= 15 * 60 * 1000,
      );
    }
    if (!matches.length) {
      method = "rewritten_subject";
      matches = compatible.filter(
        (o) =>
          o.repository === commit.repository &&
          o.subjects.includes(commit.subject) &&
          o.hashes.length &&
          o.hashes.every(
            (h) =>
              !snapshot.commits.some(
                (c) =>
                  c.repository === commit.repository && c.sha.startsWith(h),
              ),
          ) &&
          snapshot.commits.filter(
            (c) =>
              c.repository === commit.repository &&
              c.subject === commit.subject,
          ).length === 1,
      );
    }
    const groups = new Set(matches.map((o) => o.group));
    const operation =
      groups.size === 1
        ? matches.sort(
            (a, b) =>
              (a.call.occurred_at ?? Infinity) -
              (b.call.occurred_at ?? Infinity),
          )[0]
        : undefined;
    if (operation)
      matchedSha =
        operation.hashes.find((h) => commit.sha.startsWith(h)) ??
        operation.hashes[0] ??
        null;
    else method = null;
    return { operation, method, matchedSha };
  };
  // Repair only missing submission links. Existing code provenance and valid submitters
  // remain stable, even when late poll results arrive on a subsequent collection.
  const repairs = previous && !options.force ? (db.prepare(
    "SELECT repository,sha FROM adit_attribution_commits WHERE run_id=? AND submit_session_id IS NULL"
  ).all(previous.id) as Row[]).flatMap(saved => {
    const commit = snapshot.commits.find(c => c.repository === saved.repository && c.sha === saved.sha && analyzed.has(key(c.repository,c.sha)));
    if (!commit) return [];
    const match = matchSubmission(commit);
    return match.operation ? [{commit, ...match}] : [];
  }) : [];
  if (!options.force && previous && !targets.length && !repairs.length) {
    rememberSubmissionRevision(store, w, submissionInputRevision);
    return {id: previous.id, cached: true};
  }
  timer.phase("evidence");
  const evidenceStore = new AttributionEvidenceStore();
  let cleanupObjects: AttributionGitObjects | undefined;
  try {
  const gitObjects = cleanupObjects = new AttributionGitObjects();
  const parentIndex = new AttributionParentIndex(gitObjects);
  const targetPaths = new Map<string, Set<string> | null>();
  const selectFiles = db.prepare("SELECT path,additions,deletions FROM adit_local_commit_files WHERE repository=? AND sha=?");
  for (const commit of targets) {
    if (targetPaths.get(commit.repository) === null) continue;
    const files = selectFiles.all(commit.repository, commit.sha) as Row[];
    if (!files.length) targetPaths.set(commit.repository, null);
    else {
      const paths = targetPaths.get(commit.repository) ?? new Set<string>();
      for (const file of files) paths.add(normalizedPath(resolve(commit.repository, file.path)));
      targetPaths.set(commit.repository, paths);
    }
  }
  const relevantLocation = (repository: string | null, filePath: string | null) => repository !== null && targetPaths.has(repository)
    && (!filePath || targetPaths.get(repository) === null || targetPaths.get(repository)!.has(normalizedPath(filePath)));
  let missingTime = 0;
  const add = (
    source: Omit<Evidence, "id" | "text" | "group">,
    text: string,
  ) => {
    if (!relevantLocation(source.repository, source.filePath)) return;
    if (!Number.isFinite(source.at)) {
      missingTime++;
      return;
    }
    const group = identities.find(key(source.provider, source.sessionId));
    function* records(): Iterable<Evidence> {
      if (source.filePath) {
        yield { ...source, kind: "file_write", text: "",
          id: digest(["file_write", source.provider, source.sessionId, source.toolId, source.sourcePath, source.filePath]),
          group };
      }
      // The path remains useful even when its recorded contents are too large for
      // line attribution. Do not expand giant native writes into individual rows.
      if (Buffer.byteLength(text) > ATTRIBUTION_FILE_LIMIT) return;
      for (const raw of text.split(/\r?\n/)) {
        const line = normalizeLine(raw);
        if (!eligibleLine(line)) continue;
        const id = digest([
          source.provider,
          source.sessionId,
          source.toolId,
          source.sourcePath,
          source.kind,
          source.filePath,
          line,
        ]);
        yield { ...source, id, text: line, group };
      }
    }
    evidenceStore.addAll(records());
  };
  const payload = db.prepare("SELECT * FROM adit_history_tool_calls WHERE id=?");
  const latest = targets.reduce((last, commit) => Math.max(last, commit.committed_at ?? commit.authored_at ?? 0), 0);
  const sessions = new Map(snapshot.sessions.map(session => [key(session.provider, session.id), session]));
  for (const metadata of targets.length ? writeCalls(store, snapshot.scope, latest) : []) {
    options.signal?.throwIfAborted();
    const session = sessions.get(key(metadata.provider, metadata.session_id))!;
    if (metadata.file_path && isAbsolute(metadata.file_path) && /edit|write/i.test(metadata.tool_name || "")) {
      const location = writeLocation(w, metadata.working_directory || session.scope_cwd, "", metadata.file_path, session.original_root);
      if (!relevantLocation(location.repository, location.filePath)) continue;
    }
    const call = payload.get(metadata.id) as Row;
    let input: unknown;
    try {
      input = JSON.parse(call.input_json || "null");
    } catch {
      input = call.input_json;
    }
    const command = commandOf(call);
    for (const written of extractWritten(
      call.tool_name || "",
      input,
      call.command_text,
    )) {
      const location = writeLocation(
        w,
        call.working_directory || session.scope_cwd,
        command,
        written.path,
        session.original_root,
      );
      add(
        {
          provider: call.provider,
          sessionId: call.session_id,
          turnId: call.turn_id,
          toolId: call.id,
          kind: written.kind,
          sourcePath: null,
          filePath: location.filePath,
          at: call.occurred_at ?? NaN,
          repository: location.repository,
        },
        written.text,
      );
    }
  }
  const backups = targets.length ? await backupEvidence(snapshot, w, add, relevantLocation, options.signal) : {missing: previous?.missing_backup_count || 0, manifest: []},
    fingerprint = digest([snapshot.fingerprint, backups.manifest]);
  const byCommit = new Map(snapshot.commits.map(commit => [key(commit.repository, commit.sha), commit]));
  const evidenceSignature = (item: Evidence) => {
    const representative = identities.representative(key(item.provider, item.sessionId));
    return JSON.stringify([item.id, item.at, item.turnId, item.group, representative?.provider, representative?.id]);
  };
  const inputFor = (target: { repository: string; sha: string }, paths: string[] | null, prepared?: Map<string, string>): CommitInput => {
    const commit = byCommit.get(key(target.repository, target.sha))!;
    if (paths === null) {
      const files = selectFiles.all(target.repository, target.sha) as Row[];
      if (files.length) paths = [...new Set(files.filter(file => !generated(file.path)).map(file => normalizedPath(resolve(target.repository, file.path))))];
    }
    const at = commit.committed_at ?? commit.authored_at;
    function* selectedEvidence() {
      if (at == null || paths?.length === 0) return;
      if (paths === null) { yield* evidenceStore.forRepository(target.repository, at); return; }
      const seen = new Set<string>();
      let visitedFallback = false;
      for (const path of paths) {
        const selected = evidenceStore.forFile(target.repository, path, at);
        if (selected.mode === "fallback") {
          if (visitedFallback) continue;
          visitedFallback = true;
        }
        for (const item of selected.evidence) {
          if (seen.has(item.id)) continue;
          seen.add(item.id); yield item;
        }
      }
    }
    const signatures = prepared ? [...prepared.values()] : [];
    if (!prepared) for (const item of selectedEvidence()) signatures.push(evidenceSignature(item));
    return {
      scope_revision: digest([ATTRIBUTION_VERSION, "path-first", w.path, [...w.providers].sort(), target.repository]),
      paths: JSON.stringify(paths),
      evidence_revision: digest([1, at, signatures.sort()]),
    };
  };
  const sourceSessions = db.prepare(`SELECT submit_provider provider,submit_session_id session_id FROM adit_attribution_commits WHERE run_id=? AND repository=? AND sha=? AND submit_session_id IS NOT NULL
    UNION SELECT provider,session_id FROM adit_attribution_writers WHERE run_id=? AND repository=? AND sha=?
    UNION SELECT provider,session_id FROM adit_attribution_alternatives WHERE run_id=? AND repository=? AND sha=?
    UNION SELECT writer_provider,writer_session_id FROM adit_attribution_alternatives WHERE run_id=? AND repository=? AND sha=?
    UNION SELECT provider,session_id FROM adit_attribution_turns WHERE run_id=? AND repository=? AND sha=?`);
  const resume = options.force ? { commits: [], manifest: [] } : await resumableCommits(store, w.id, ATTRIBUTION_VERSION,
    snapshot.commits.map(c => ({ repository: c.repository as string, sha: c.sha as string })), analyzed, rechecks, inputFor,
    (run, commit) => (sourceSessions.all(...Array.from({ length: 5 }, () => [run, commit.repository, commit.sha]).flat()) as Row[])
      .every(source => sessions.has(key(source.provider, source.session_id))));
  targets = targets.filter(commit => !analyzed.has(key(commit.repository, commit.sha)));
  const resumedRepairs = resume.commits.flatMap(saved => {
    const result = db.prepare("SELECT submit_session_id FROM adit_attribution_commits WHERE run_id=? AND repository=? AND sha=?")
      .get(saved.run, saved.repository, saved.sha) as Row;
    if (result.submit_session_id !== null) return [];
    const commit = byCommit.get(key(saved.repository, saved.sha))!;
    const match = matchSubmission(commit);
    return match.operation ? [{ commit, ...match }] : [];
  });
  const run = randomUUID();

  db.prepare(
    "INSERT INTO adit_attribution_runs (id,workspace_id,algorithm_version,input_fingerprint,status,started_at,commit_count,missing_time_count,missing_backup_count) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    run,
    w.id,
    ATTRIBUTION_VERSION,
    fingerprint,
    "running",
    Date.now(),
    targets.length + repairs.length + resume.commits.length,
    targets.length ? missingTime : previous?.missing_time_count || 0,
    backups.missing,
  );
  try {
  db.transaction(() => {
    const manifest = [...new Map([...resume.manifest, ...backups.manifest].map(item => [JSON.stringify(item), item])).values()];
    db.prepare("INSERT INTO adit_attribution_resume VALUES (?,?,?)").run(run, snapshot.evidenceRevision, JSON.stringify(manifest));
    copyResumedCommits(store, run, resume.commits);
    const saveInput = db.prepare("INSERT OR REPLACE INTO adit_attribution_inputs VALUES (?,?,?,?,?,?)");
    for (const commit of resume.commits)
      saveInput.run(run, commit.repository, commit.sha, commit.input.scope_revision, commit.input.paths, commit.input.evidence_revision);
    db.prepare("UPDATE adit_attribution_runs SET completed_count=? WHERE id=?").run(resume.commits.length, run);
    // The new run owns durable copies before obsolete partial snapshots are removed.
    pruneResumedRuns(store, w.id, run);
  })();
    let completed = resume.commits.length;
    const failures: string[] = [];
    let trace: AttributionCommitTimer | undefined;
    const diffReader = new AttributionDiffReader((repository, args, signal) => timer.measure("gitDiff", () => trace
      ? trace.git(args, () => git(repository, args, signal)) : git(repository, args, signal)), gitObjects);
    timer.phase("commits");
    for (const [commitIndex, commit] of targets.entries()) {
      trace = timer.commit(commit.repository, commit.sha);
      const objectStats = trace ? { ...gitObjects.stats } : undefined;
      let traceStatus: CommitTiming["status"] = "failed";
      try {
      const retry = db.prepare("SELECT error,retry_at,input_revision FROM adit_attribution_failures WHERE workspace_id=? AND repository=? AND sha=?").get(w.id,commit.repository,commit.sha) as Row | undefined;
      // Git failures belong to this repository/SHA. Chat activity cannot make
      // an oversized immutable patch smaller or bypass its retry backoff.
      const legacyLargePatch = retry?.error.includes("Commit patch exceeds the 8 MiB analysis size limit");
      if (!options.force && !rechecks.has(key(commit.repository, commit.sha)) && retry && retry.retry_at > Date.now() && !legacyLargePatch) {
        traceStatus = "deferred";
        failures.push(retry.error); continue;
      }
      options.signal?.throwIfAborted();
      options.progress?.(commit.repository);
      const at = commit.committed_at ?? commit.authored_at;
      const indexedFiles = selectFiles.all(commit.repository, commit.sha) as { path: string; additions: number | null; deletions: number | null }[];
      trace?.count("changedFiles", indexedFiles.length);
      trace?.phase("gitDiff");
      const upcoming = targets.slice(commitIndex + 1, commitIndex + 16)
        .filter(target => target.repository === commit.repository).map(target => target.sha);
      const summaries = new AttributionSummaries();
      const totals = { eligible: 0, excluded: 0, certain: 0, likely: 0, possible: 0, moved: 0, unknown: 0 };
      const parsedPaths = new Set<string>(), paths = new Set<string>();
      const inputSignatures = new Map<string, string>();
      let visitedInputFallback = false;
      function* trackInput(records: Iterable<Evidence>) {
        for (const item of records) {
          if (!inputSignatures.has(item.id)) inputSignatures.set(item.id, evidenceSignature(item));
          yield item;
        }
      }
      const { fileOnly } = await diffReader.read(commit.repository, commit.sha, gitSourcePaths, options.signal, indexedFiles, upcoming, async (patch, diff) => {
        options.signal?.throwIfAborted();
        const { parents } = diff;
        trace?.phase("parsePatch");
        const lines = parseAddedLines(patch);
        if (trace) {
          trace.count("patchBytes", Buffer.byteLength(patch));
          trace.count("parsedLines", lines.length);
        }
        for (const line of lines) parsedPaths.add(line.path);
        trace?.phase("parentScan");
        const oldLines = new Set<string>();
        if (parents.length && lines.some((l) => !l.excluded)) {
          const wanted = new Set(
            lines.filter((l) => !l.excluded).map((l) => l.text),
          );
          for (const line of await timer.measure("parentScan", () =>
            parentIndex.matching(commit.repository, parents[0], diff.parentFiles, diff.parentPaths, wanted, options.signal,
              trace ? timing => trace!.parentScan(timing) : undefined))) oldLines.add(line);
        }

        trace?.phase("fileEvidence");
        let fallback: AttributionMatchIndex | undefined;
        let currentIndex: { path: string; index: AttributionMatchIndex } | undefined;
        const evidenceById = new Map<string, Evidence>();
        for (const line of lines)
          if (!line.excluded && !oldLines.has(line.text)) paths.add(resolve(commit.repository, line.path));

        const indexFor = (line: AddedLine) => {
          const path = normalizedPath(resolve(commit.repository, line.path));
          if (currentIndex?.path === path) return currentIndex.index;
          const started = performance.now();
          const selected = at == null ? { mode: "path", evidence: [] } : evidenceStore.forFile(commit.repository, path, at);
          trace?.count(selected.mode === "fallback" ? "fallbackFiles" : "pathFiles");
          if (selected.mode === "fallback" && fallback) trace?.count("reusedFallbackIndexes");
          const countEvidence = trace ? () => trace!.count("candidateRecords") : undefined;
          if (selected.mode === "fallback") visitedInputFallback = true;
          const index = selected.mode === "fallback"
            ? fallback ??= new AttributionMatchIndex(trackInput(selected.evidence), countEvidence)
            : new AttributionMatchIndex(trackInput(selected.evidence), countEvidence);
          // Diffs group lines by path. Keep only the active file's index plus one
          // shared fallback; retain evidence bodies only for actual candidates.
          currentIndex = { path, index };
          timer.add("evidenceLookup", started);
          trace?.lookup(started);
          return index;
        };
        trace?.phase("matchLines");
        const perLine = new Map<AddedLine, AttributionMatch[]>(),
          support = new Map<string, number>();
        for (const line of lines) {
          if (line.excluded || oldLines.has(line.text)) continue;
          trace?.count("comparedLines");
          const index = indexFor(line);
          let matches = index.matching(line.text);
          for (const group of new Set(matches.map((c) => c.e.group))) {
            const k = line.hunk + "\0" + group;
            support.set(k, (support.get(k) || 0) + 1);
          }
          // Fuzzy candidates do not count as exact hunk support, as before.
          if (!matches.length) matches = index.approximate(line.text);
          trace?.count(matches.length ? "matchedLines" : "unmatchedLines");
          perLine.set(line, matches);
          for (const match of matches) evidenceById.set(digest([run, match.e.id]), match.e);
        }
        currentIndex = undefined; fallback = undefined;
        trace?.phase("classifyLines");
        const attributionRows: (AttributionLine & Row)[] = [];
        const candidatesRows: (AttributionCandidate & Row)[] = [];
        for (const line of lines) {
          const id = digest([
            run,
            commit.repository,
            commit.sha,
            line.path,
            line.number,
          ]);
          let tier = "unknown",
            selected: AttributionMatch | undefined;
          let candidates = perLine.get(line) || [];
          if (line.excluded) {
            tier = "excluded";
            totals.excluded++;
          } else {
            totals.eligible++;
            if (oldLines.has(line.text)) tier = "moved";
            else {
              const groups = new Map<string, AttributionMatch>();
              for (const c of candidates) {
                const old = groups.get(c.e.group);
                if (
                  !old ||
                  c.score > old.score ||
                  (c.score === old.score && c.e.at > old.e.at)
                )
                  groups.set(c.e.group, c);
              }
              candidates = [...groups.values()].sort(
                (a, b) =>
                  (support.get(line.hunk + "\0" + b.e.group) || 0) -
                    (support.get(line.hunk + "\0" + a.e.group) || 0) ||
                  b.score - a.score ||
                  b.e.at - a.e.at ||
                  a.e.id.localeCompare(b.e.id),
              );
              selected = candidates[0];
              if (selected)
                tier =
                  selected.method === "token_overlap"
                    ? "possible"
                    : candidates.length === 1
                      ? "certain"
                      : "likely";
            }
            totals[
              tier as "certain" | "likely" | "possible" | "moved" | "unknown"
            ]++;
          }
          const who = selected
            ? identities.representative(
                key(selected.e.provider, selected.e.sessionId),
              )
            : null;
          attributionRows.push({
            id,
            path: line.path,
            number: line.number,
            hunk: line.hunk,
            hash: digest(line.text),
            tier,
            provider: who?.provider ?? null,
            session: who?.id ?? null,
            evidence: selected ? digest([run, selected.e.id]) : null,
            method: selected?.method ?? null,
            score: selected?.score ?? null,
          });
          for (const candidate of candidates) {
            const who = identities.representative(
              key(candidate.e.provider, candidate.e.sessionId),
            );
            candidatesRows.push({
              line: id,
              provider: who.provider,
              session: who.id,
              evidence: digest([run, candidate.e.id]),
              support: support.get(line.hunk + "\0" + candidate.e.group) || 0,
              at: candidate.e.at,
              selected: Number(candidate === selected),
            });
          }
        }
        summaries.add(attributionRows, candidatesRows, evidenceById);
        trace?.phase("gitDiff");
      });
      trace?.count("fileOnlyFiles", fileOnly.length);
      totals.excluded += indexedFiles
        .filter(file => generated(file.path) && !parsedPaths.has(file.path) && !fileOnly.some(skipped => skipped.path === file.path))
        .reduce((sum, file) => sum + (file.additions || 0), 0);
      totals.excluded += fileOnly.reduce((sum, file) => sum + (file.additions || 0), 0);
      const fileOnlyPaths = fileOnly.map(file => resolve(commit.repository, file.path));
      for (const path of fileOnlyPaths) paths.add(path);
      const skippedPaths = new Map(fileOnly.map(file => [normalizedPath(resolve(commit.repository, file.path)), file.path]));
      trace?.phase("fileEvidence");
      const lookupStarted = performance.now();
      for (const evidence of fileOnlyPaths.length && at != null ? evidenceStore.forFileWrites(commit.repository, fileOnlyPaths, at) : []) {
        const who = identities.representative(key(evidence.provider, evidence.sessionId));
        summaries.add([], [], new Map(), [{
          path: skippedPaths.get(normalizedPath(evidence.filePath!))!, provider: who.provider, session: who.id, source: evidence,
        }]);
      }
      timer.add("evidenceLookup", lookupStarted);
      const { operation, method, matchedSha } = matchSubmission(commit);
      trace?.phase("inputRevision");
      // Content-matched files already supplied their exact input stamp while
      // constructing the index. File-only changes still need their write scope.
      if (at != null) for (const path of fileOnlyPaths) {
        const selected = evidenceStore.forFile(commit.repository, path, at);
        if (selected.mode === "fallback" && visitedInputFallback) continue;
        if (selected.mode === "fallback") visitedInputFallback = true;
        for (const item of selected.evidence)
          if (!inputSignatures.has(item.id)) inputSignatures.set(item.id, evidenceSignature(item));
      }
      const commitInput = inputFor({ repository: commit.repository, sha: commit.sha }, [...paths], inputSignatures);
      trace?.phase("persist");
      db.transaction(() => {
        summaries.save(db, run, commit.repository, commit.sha);
        const saveFile = db.prepare("INSERT INTO adit_attribution_files VALUES (?,?,?,?,?,?,?)");
        for (const file of fileOnly) saveFile.run(run, commit.repository, commit.sha, file.path, file.reason, file.additions, file.deletions);
        db.prepare(
          "INSERT INTO adit_attribution_commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          run,
          commit.repository,
          commit.sha,
          operation?.call.provider ?? null,
          operation?.call.session_id ?? null,
          operation?.call.turn_id ?? null,
          operation?.call.id ?? null,
          method,
          matchedSha,
          totals.eligible,
          totals.excluded,
          totals.certain,
          totals.likely,
          totals.possible,
          totals.moved,
          totals.unknown,
        );
        db.prepare("INSERT INTO adit_attribution_inputs VALUES (?,?,?,?,?,?)")
          .run(run, commit.repository, commit.sha, commitInput.scope_revision, commitInput.paths, commitInput.evidence_revision);
        db.prepare(
          "UPDATE adit_attribution_runs SET completed_count=? WHERE id=?",
        ).run(++completed, run);
        db.prepare("DELETE FROM adit_attribution_failures WHERE workspace_id=? AND repository=? AND sha=?").run(w.id,commit.repository,commit.sha);
      })();
      traceStatus = "done";
      } catch (error) {
        if (options.signal?.aborted) traceStatus = "cancelled";
        if (options.signal?.aborted || String((error as {code?: string}).code || "").startsWith("SQLITE_")) throw error;
        const code = (error as {code?: string | number}).code;
        const reason = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? "Commit patch exceeds the 8 MiB analysis size limit; explicit review is required"
          : code !== undefined ? `Git command failed (${code})` : error instanceof Error ? error.message.slice(0,300) : "Commit analysis failed";
        const message = `${commit.sha.slice(0,12)}: ${reason}`;
        failures.push(message);
        const retryAt = reason.includes("analysis size limit") ? Number.MAX_SAFE_INTEGER : Date.now()+15*60_000;
        db.prepare(`INSERT INTO adit_attribution_failures VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,repository,sha)
          DO UPDATE SET input_revision=excluded.input_revision,error=excluded.error,retry_at=excluded.retry_at`).run(w.id,commit.repository,commit.sha,snapshot.evidenceRevision,message,retryAt);
      } finally {
        if (trace && objectStats) for (const name of Object.keys(objectStats) as (keyof typeof objectStats)[])
          trace.count(name, gitObjects.stats[name] - objectStats[name]);
        trace?.finish(traceStatus);
        trace = undefined;
      }
    }
    if (failures.length) throw new Error(`${failures.length} commits pending analysis; completed results retained. ${failures[0]}`);
    timer.phase("publish");
    // Never publish a mixed snapshot if collection/settings changed during the analysis.
    const currentWorkspace = store.workspace(w.id);
    if (
      digest([
        currentWorkspace.path,
        currentWorkspace.providers,
        currentWorkspace.repositories,
      ]) !== digest([w.path, w.providers, w.repositories]) ||
      inputMetadata(store, w).fingerprint !== snapshot.fingerprint
    )
      throw new Error("采集记录已更新，将在下一次采集后重试未完成的提交分析");
    db.transaction(() => {
      if (savedRun(store, w.id)?.id !== previous?.id)
        throw new Error(
          "已有分析结果已更新，将在下一次采集后重试未完成的提交分析",
        );
      if (previous && !options.force) {
        // Replace explicit rechecks and file-policy corrections at publication. A failed
        // recheck leaves the previous complete snapshot readable and untouched.
        for (const target of recheckTargets) {
          for (const table of ATTRIBUTION_RESULT_TABLES)
            db.prepare(
              `DELETE FROM adit_attribution_${table} WHERE run_id=? AND repository=? AND sha=?`,
            ).run(previous.id, target.repository, target.sha);
        }
        // Publish a complete readable snapshot without re-matching old commits.
        // Carry writer counts, alternatives and original-session/turn links together.
        // Previously seen SHAs stay cached even when a branch/repository is hidden;
        // readers still restrict results to the currently collected repository set.
        for (const table of ATTRIBUTION_RESULT_TABLES)
          db.prepare(
            `UPDATE adit_attribution_${table} SET run_id=? WHERE run_id=?`,
          ).run(run, previous.id);
      }
      for (const {commit, operation, method, matchedSha} of [...repairs, ...resumedRepairs]) {
        const call = operation!.call;
        db.prepare(`UPDATE adit_attribution_commits SET submit_provider=?,submit_session_id=?,submit_turn_id=?,submit_tool_call_id=?,match_method=?,matched_sha=?
          WHERE run_id=? AND repository=? AND sha=? AND submit_session_id IS NULL`)
          .run(call.provider,call.session_id,call.turn_id,call.id,method,matchedSha,run,commit.repository,commit.sha);
      }
      db.prepare("UPDATE adit_attribution_runs SET completed_count=completed_count+? WHERE id=?").run(repairs.length,run);
      db.prepare(
        "UPDATE adit_attribution_runs SET status='done',finished_at=? WHERE id=?",
      ).run(Date.now(), run);
      db.prepare(
        "DELETE FROM adit_attribution_runs WHERE workspace_id=? AND status='done' AND id<>?",
      ).run(w.id, run);
      pruneResumedRuns(store, w.id, run);
    })();
    rememberSubmissionRevision(store, w, submissionInputRevision);
    return { id: run, cached: false };
  } catch (error) {
    db.prepare(
      "UPDATE adit_attribution_runs SET status='failed',finished_at=?,error=? WHERE id=?",
    ).run(
      Date.now(),
      error instanceof Error ? error.message : "Analysis failed",
      run,
    );
    pruneResumedRuns(store, w.id, run);
    throw error;
  }
  } finally {
    evidenceStore.close();
    await cleanupObjects?.close();
  }
}
