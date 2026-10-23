import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute, basename, relative } from "node:path";
import {
  LocalStore,
  createAttributionSchema,
  ATTRIBUTION_RESULT_TABLES,
  NON_MERGE_COMMIT_SQL,
  insideDirectory,
  analyticsSessions,
  projectSessionLocations,
  type LocalWorkspace,
} from "@varveai/adit-core";
import {
  normalizeLine,
  eligibleLine,
  extractWritten,
  jsonTextValue,
  wordTokens,
  tokenOverlap,
  literals,
} from "./attribution-evidence.js";
import { saveAttributionSummaries, type AttributionLine, type AttributionCandidate } from "./attribution-summaries.js";
const execute = promisify(execFile);
export const ATTRIBUTION_VERSION = 4;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Row = Record<string, any>;
type Evidence = {
  id: string;
  provider: string;
  sessionId: string;
  turnId: string | null;
  toolId: string | null;
  kind: string;
  sourcePath: string | null;
  filePath: string | null;
  at: number;
  text: string;
  group: string;
  repository: string | null;
};
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
export function analysisIdentities(sessions: Row[], calls: Row[]) {
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

function collectedCommits(store: LocalStore, w: LocalWorkspace) {
  const select = store.db.prepare(
    `SELECT c.* FROM adit_local_commits c WHERE c.repository=? AND ${NON_MERGE_COMMIT_SQL} ORDER BY c.committed_at,c.sha`,
  );
  return w.repositories.flatMap(
    (repository) => select.all(repository) as Row[],
  );
}

function savedRun(store: LocalStore, workspaceId: string) {
  return store.db
    .prepare(
      "SELECT * FROM adit_attribution_runs WHERE workspace_id=? AND status='done' ORDER BY started_at DESC LIMIT 1",
    )
    .get(workspaceId) as Row | undefined;
}

function inputSnapshot(store: LocalStore, w: LocalWorkspace) {
  const db = store.db;
  return db.transaction(() => {
    const scopes = new Map(analyticsSessions(db,w).map(s=>[key(s.provider,s.id),s.cwd]));
    const locations = projectSessionLocations(db,w);
    const sessions = (
      db
        .prepare(
          `SELECT s.*,coalesce(nullif(s.cwd,''),a.workspace,'') scope_cwd FROM adit_history_sessions s LEFT JOIN adit_history_assignments a ON a.provider=s.provider AND a.session_id=s.id`,
        )
        .all() as Row[]
    ).filter((s) => w.providers.includes(s.provider) && scopes.has(key(s.provider,s.id)))
      .map((s): Row=>({...s,scope_cwd:scopes.get(key(s.provider,s.id))!,original_root:locations.get(key(s.provider,s.id))?.original_root}));
    const keys = new Set(sessions.map((s) => key(s.provider, s.id)));
    const calls = (
      db
        .prepare(
          `SELECT t.* FROM adit_history_tool_calls t WHERE NOT EXISTS (SELECT 1 FROM adit_history_tool_results r WHERE r.tool_call_id=t.id AND (r.status IN ('error','failed') OR r.exit_code<>0))`,
        )
        .all() as Row[]
    ).filter((c) => keys.has(key(c.provider, c.session_id))).map(c=> {
      const location=locations.get(key(c.provider,c.session_id));
      if (!location || !c.working_directory || !insideDirectory(location.original_root,c.working_directory)) return c;
      return {...c,working_directory:resolve(w.path,relative(location.original_root,c.working_directory))};
    });
    const callIds = new Set(calls.map((c) => c.id));
    const results = (
      db
        .prepare(
          "SELECT tool_call_id,content_text,occurred_at,exit_code,status FROM adit_history_tool_results WHERE tool_call_id IS NOT NULL",
        )
        .all() as Row[]
    ).filter((r) => callIds.has(r.tool_call_id));
    const commits = collectedCommits(store, w);
    const sources = (
      db
        .prepare(
          "SELECT provider,session_id,path,fingerprint FROM adit_history_sources WHERE provider='claude'",
        )
        .all() as Row[]
    ).filter((s) => keys.has(key(s.provider, s.session_id)));
    const fingerprint = digest([
      ATTRIBUTION_VERSION,
      w.path,
      w.providers,
      w.repositories,
      sessions.map((s) => [s.provider, s.id, s.transcript_revision]),
      commits.map((c) => [c.repository, c.sha, c.committed_at, c.authored_at]),
      sources,
    ]);
    return { sessions, calls, results, commits, sources, fingerprint };
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
      maxBuffer: 64 * 1024 * 1024,
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

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => {
    const path = resolve(value);
    return process.platform === "win32" ? path.toLowerCase() : path;
  };
  return normalize(a) === normalize(b);
}
function commandOf(call: Row): string {
  if (call.command_text) return call.command_text;
  try {
    const input = JSON.parse(call.input_json || "null");
    return typeof input === "string"
      ? input
      : (input?.code ?? input?.script ?? input?.command ?? input?.cmd ?? "");
  } catch {
    return "";
  }
}
function commitCommand(command: string): boolean {
  return (
    !/^\s*(?:rg|grep|cat|Get-Content)\b/i.test(command) &&
    /\bgit(?:[\s'",\[\]-]|\\["'])[^\n]{0,200}?\bcommit\b/.test(command)
  );
}
function subjects(command: string, output: string): string[] {
  const values: string[] = [];
  for (const m of output.matchAll(/^\[[^\]\r\n]+ [a-f0-9]{7,64}\]\s+(.+)$/gm))
    values.push(m[1].trim());
  for (const m of command.matchAll(
    /\bgit\b[^\n]*?\bcommit\b[^\n]*?(?:-m|--message)(?:[=\s]+)("(?:\\.|[^"\\])*"|'[^']*')/g,
  )) {
    const lit = literals(m[1])[0];
    if (lit) values.push(lit.text.split("\n")[0]);
  }
  if (/\bcommit\b[^\n]*-F\s+-/.test(command)) {
    const m = /<<\s*['"]?(\w+)['"]?\s*\n([^\n]+)/.exec(command);
    if (m) values.push(m[2].trim());
  }
  // Native script APIs frequently execute ['git', 'commit', '-m', subject].
  const tokens = literals(command).map((s) => s.text);
  for (let i = 0; i < tokens.length - 3; i++)
    if (
      tokens[i] === "git" &&
      tokens[i + 1] === "commit" &&
      ["-m", "--message"].includes(tokens[i + 2])
    )
      values.push(tokens[i + 3].split("\n")[0]);
  return [...new Set(values.filter(Boolean))];
}

function nativeOutput(text: string): string {
  const unpack = (value: any): string =>
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.map(unpack).join("\n")
        : value && typeof value === "object"
          ? ["output", "stdout", "text", "content"]
              .filter((k) => k in value)
              .map((k) => unpack(value[k]))
              .join("\n")
          : "";
  try {
    return unpack(JSON.parse(text)) || text;
  } catch {}
  return text
    .split("\n")
    .map((line) => {
      try {
        return unpack(JSON.parse(line)) || line;
      } catch {
        return line.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
      }
    })
    .join("\n");
}

async function backupEvidence(
  snapshot: ReturnType<typeof inputSnapshot>,
  w: LocalWorkspace,
  add: (source: Omit<Evidence, "id" | "text" | "group">, text: string) => void,
) {
  let missing = 0;
  const manifest: unknown[] = [];
  for (const source of snapshot.sources) {
    let text: string;
    try {
      const info = await stat(source.path);
      if (info.size > 128 * 1024 * 1024) {
        missing++;
        continue;
      }
      text = await readFile(source.path, "utf8");
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
    for (const line of text.split("\n")) {
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
            const location = writeLocation(w, session.scope_cwd, "", file,session.original_root);
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
        } catch {
          missing++;
          manifest.push([path, "missing"]);
        }
      }
    }
  }
  return { missing, manifest };
}

export async function analyzeAttribution(
  store: LocalStore,
  w: LocalWorkspace,
  options: {
    signal?: AbortSignal;
    force?: boolean;
    recheck?: { repository: string; sha: string }[];
    progress?: (repository:string)=>void;
  } = {},
) {
  createAttributionSchema(store.db);
  const db = store.db;
  options.signal?.throwIfAborted();
  // Detect new SHAs before loading transcripts or backups. Changed sessions and
  // algorithm versions do not silently rewrite previously saved attribution.
  const { previous, analyzed, pending } = db.transaction(() => {
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
    for (const target of options.recheck || [])
      analyzed.delete(key(target.repository, target.sha));
    return {
      previous,
      analyzed,
      pending: commits.some((c) => !analyzed.has(key(c.repository, c.sha))),
    };
  })();
  if (!options.force && previous && !pending)
    return { id: previous.id, cached: true };
  const snapshot = inputSnapshot(store, w),
    identities = analysisIdentities(snapshot.sessions, snapshot.calls);
  const targets = snapshot.commits.filter(
    (c) => !analyzed.has(key(c.repository, c.sha)),
  );
  const evidence: Evidence[] = [];
  const unique = new Set<string>();
  let missingTime = 0;
  const add = (
    source: Omit<Evidence, "id" | "text" | "group">,
    text: string,
  ) => {
    if (!Number.isFinite(source.at)) {
      missingTime++;
      return;
    }
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
      if (unique.has(id)) continue;
      unique.add(id);
      evidence.push({
        ...source,
        id,
        text: line,
        group: identities.find(key(source.provider, source.sessionId)),
      });
    }
  };
  for (const call of snapshot.calls) {
    options.signal?.throwIfAborted();
    const session = snapshot.sessions.find(
      (s) => s.provider === call.provider && s.id === call.session_id,
    )!;
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
  const backups = await backupEvidence(snapshot, w, add),
    fingerprint = digest([snapshot.fingerprint, backups.manifest]);
  const run = randomUUID();
  db.prepare(
    "DELETE FROM adit_attribution_runs WHERE workspace_id=? AND status='failed'",
  ).run(w.id);
  db.prepare(
    "INSERT INTO adit_attribution_runs (id,workspace_id,algorithm_version,input_fingerprint,status,started_at,commit_count,missing_time_count,missing_backup_count) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    run,
    w.id,
    ATTRIBUTION_VERSION,
    fingerprint,
    "running",
    Date.now(),
    targets.length,
    missingTime,
    backups.missing,
  );
  const exact = new Map<string, Evidence[]>(),
    values = new Map<string, Evidence[]>(),
    tokens = new Map<string, Set<string>>(),
    postings = new Map<string, Set<string>>(),
    texts = new Map<string, Evidence[]>();
  for (const e of evidence) {
    const list = exact.get(e.text) || [];
    list.push(e);
    exact.set(e.text, list);
    const value = jsonTextValue(e.text);
    if (value) {
      const same = values.get(value) || [];
      same.push(e);
      values.set(value, same);
    }
    if (!texts.has(e.text)) {
      const words = wordTokens(e.text);
      tokens.set(e.text, words);
      for (const word of words) {
        const set = postings.get(word) || new Set<string>();
        set.add(e.text);
        postings.set(word, set);
      }
    }
    texts.set(e.text, list);
  }
  const completedCalls = new Set(snapshot.results.map((r) => r.tool_call_id));
  const operations = snapshot.calls
    .filter((c) => completedCalls.has(c.id) && commitCommand(commandOf(c)))
    .map((call) => {
      const output = snapshot.results
        .filter((r) => r.tool_call_id === call.id)
        .map((r) => nativeOutput(r.content_text || ""))
        .join("\n");
      const session = snapshot.sessions.find(
        (s) => s.provider === call.provider && s.id === call.session_id,
      )!;
      return {
        call,
        group: identities.find(key(call.provider, call.session_id)),
        repository: repositoryFor(
          w,
          call.working_directory || session.scope_cwd,
          commandOf(call),
          session.original_root,
        ),
        hashes: [...output.matchAll(/^\[[^\]\r\n]+ ([a-f0-9]{7,64})\]/gm)].map(
          (m) => m[1],
        ),
        subjects: subjects(commandOf(call), output),
      };
    });
  const evidenceById = new Map(evidence.map((e) => [digest([run, e.id]), e]));
  try {
    let completed = 0;
    for (const commit of targets) {
      options.signal?.throwIfAborted();
      options.progress?.(commit.repository);
      const at = commit.committed_at ?? commit.authored_at;
      const patch = await git(
        commit.repository,
        [
          "-c",
          "core.quotePath=false",
          "show",
          "--format=",
          "--first-parent",
          "--diff-merges=first-parent",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--unified=0",
          commit.sha,
          "--",
          ...gitSourcePaths,
        ],
        options.signal,
      );
      const lines = parseAddedLines(patch);
      const parents = (
        await git(
          commit.repository,
          ["rev-list", "--parents", "-n", "1", commit.sha],
          options.signal,
        )
      )
        .trim()
        .split(/\s+/)
        .slice(1);
      const oldLines = new Set<string>();
      if (parents.length && lines.some((l) => !l.excluded)) {
        const wanted = new Set(
          lines.filter((l) => !l.excluded).map((l) => l.text),
        );
        let content = "";
        try {
          content = await git(
            commit.repository,
            [
              "grep",
              "--threads=1",
              "--no-textconv",
              "-I",
              "-h",
              "-e",
              ".",
              parents[0],
              "--",
              ...gitSourcePaths,
            ],
            options.signal,
          );
        } catch (error) {
          if ((error as { code?: number }).code !== 1) throw error;
        }
        for (const raw of content.split("\n")) {
          const line = normalizeLine(raw);
          if (wanted.has(line)) oldLines.add(line);
        }
      }

      type Candidate = { e: Evidence; method: string; score: number };
      const perLine = new Map<AddedLine, Candidate[]>(),
        support = new Map<string, number>();
      const allowed = (e: Evidence, line: AddedLine) =>
        at !== null &&
        e.at <= at &&
        (e.filePath
          ? samePath(e.filePath, resolve(commit.repository, line.path))
          : e.repository === commit.repository);
      for (const line of lines) {
        if (line.excluded || oldLines.has(line.text)) continue;
        let matches = (exact.get(line.text) || [])
          .filter((e) => allowed(e, line))
          .map((e) => ({ e, method: "exact", score: 1 }));
        if (!matches.length) {
          const value = jsonTextValue(line.text);
          if (value)
            matches = [
              ...(values.get(value) || []),
              ...(exact.get(value) || []),
            ]
              .filter((e) => allowed(e, line))
              .map((e) => ({ e, method: "json_value", score: 1 }));
        }
        perLine.set(line, matches);
        for (const group of new Set(matches.map((c) => c.e.group))) {
          const k = line.hunk + "\0" + group;
          support.set(k, (support.get(k) || 0) + 1);
        }
      }
      const attributionRows: (AttributionLine & Row)[] = [];
      const candidatesRows: (AttributionCandidate & Row)[] = [];
      const totals = {
        eligible: 0,
        excluded: 0,
        certain: 0,
        likely: 0,
        possible: 0,
        moved: 0,
        unknown: 0,
      };
      totals.excluded = (
        db
          .prepare(
            "SELECT path,additions FROM adit_local_commit_files WHERE repository=? AND sha=?",
          )
          .all(commit.repository, commit.sha) as Row[]
      )
        .filter(
          (f) => generated(f.path) && !lines.some((l) => l.path === f.path),
        )
        .reduce((sum, f) => sum + (f.additions || 0), 0);
      for (const line of lines) {
        const id = digest([
          run,
          commit.repository,
          commit.sha,
          line.path,
          line.number,
        ]);
        let tier = "unknown",
          selected: Candidate | undefined;
        let candidates = perLine.get(line) || [];
        if (line.excluded) {
          tier = "excluded";
          totals.excluded++;
        } else {
          totals.eligible++;
          if (oldLines.has(line.text)) tier = "moved";
          else {
            if (!candidates.length) {
              const words = wordTokens(line.text),
                matches = new Set<string>();
              const rare = [...words]
                .sort(
                  (a, b) =>
                    (postings.get(a)?.size || 0) - (postings.get(b)?.size || 0),
                )
                .slice(0, Math.floor(words.size * 0.1) + 1);
              for (const word of rare)
                for (const text of postings.get(word) || []) matches.add(text);
              for (const text of matches) {
                const other = tokens.get(text)!;
                if (
                  Math.min(words.size, other.size) /
                    Math.max(words.size, other.size) <
                  0.9
                )
                  continue;
                const score = tokenOverlap(words, other);
                if (score < 0.9) continue;
                for (const e of texts.get(text) || [])
                  if (allowed(e, line))
                    candidates.push({ e, method: "token_overlap", score });
              }
            }
            const groups = new Map<string, Candidate>();
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
      db.transaction(() => {
        saveAttributionSummaries(db, run, commit.repository, commit.sha, attributionRows, candidatesRows, evidenceById);
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
        db.prepare(
          "UPDATE adit_attribution_runs SET completed_count=? WHERE id=?",
        ).run(++completed, run);
      })();
    }
    // Never publish a mixed snapshot if collection/settings changed during the analysis.
    const currentWorkspace = store.workspace(w.id);
    if (
      digest([
        currentWorkspace.path,
        currentWorkspace.providers,
        currentWorkspace.repositories,
      ]) !== digest([w.path, w.providers, w.repositories]) ||
      inputSnapshot(store, w).fingerprint !== snapshot.fingerprint
    )
      throw new Error("采集记录已更新，将在下一次采集后重试未完成的提交分析");
    db.transaction(() => {
      if (savedRun(store, w.id)?.id !== previous?.id)
        throw new Error(
          "已有分析结果已更新，将在下一次采集后重试未完成的提交分析",
        );
      if (previous && !options.force) {
        // Replace only explicitly rechecked commits at publication time. A failed
        // recheck leaves the previous complete snapshot readable and untouched.
        for (const target of options.recheck || []) {
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
      db.prepare(
        "UPDATE adit_attribution_runs SET status='done',finished_at=? WHERE id=?",
      ).run(Date.now(), run);
      db.prepare(
        "DELETE FROM adit_attribution_runs WHERE workspace_id=? AND id<>?",
      ).run(w.id, run);
    })();
    return { id: run, cached: false };
  } catch (error) {
    db.prepare(
      "UPDATE adit_attribution_runs SET status='failed',finished_at=?,error=? WHERE id=?",
    ).run(
      Date.now(),
      error instanceof Error ? error.message : "Analysis failed",
      run,
    );
    throw error;
  }
}
