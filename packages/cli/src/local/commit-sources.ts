import {
  LocalStateError,
  redactOverview,
  NON_MERGE_COMMIT_SQL,
  type LocalStore,
  type LocalWorkspace,
} from "@varveai/adit-core";
type Row = Record<string, any>;
export function attributionStatus(store: Pick<LocalStore, "db">, workspaceId: string) {
  const latest = store.db
    .prepare(
      "SELECT id,status,finished_at,completed_count,commit_count,error FROM adit_attribution_runs WHERE workspace_id=? ORDER BY started_at DESC LIMIT 1",
    )
    .get(workspaceId) as Row | undefined;
  const saved = store.db
    .prepare(
      "SELECT id,finished_at,missing_time_count,missing_backup_count FROM adit_attribution_runs WHERE workspace_id=? AND status='done' ORDER BY started_at DESC LIMIT 1",
    )
    .get(workspaceId) as Row | undefined;
  return {
    runId: saved?.id ?? null,
    status: latest?.status ?? "pending",
    finishedAt: saved?.finished_at ?? null,
    completed: latest?.completed_count ?? 0,
    total: latest?.commit_count ?? 0,
    error: latest?.error ?? null,
    stale: !!saved && latest?.id !== saved.id,
    missingTimes: saved?.missing_time_count ?? 0,
    missingBackups: saved?.missing_backup_count ?? 0,
  };
}
/** Read-only projection. GET never runs Git, scans transcripts, or writes analysis. */
export async function queryCommitSources(
  store: Pick<LocalStore, "db">,
  w: LocalWorkspace,
  repository: string,
  sha: string,
) {
  return store.db.transaction(() =>
    readCommitSources(store, w, repository, sha),
  )();
}
function readCommitSources(
  store: Pick<LocalStore, "db">,
  w: LocalWorkspace,
  repository: string,
  sha: string,
) {
  if (!w.repositories.includes(repository) || !/^[a-f0-9]{40,64}$/.test(sha))
    throw new LocalStateError("Invalid commit", 400);
  const db = store.db;
  if (
    !db
      .prepare(
        `SELECT 1 FROM adit_local_commits c WHERE c.repository=? AND c.sha=? AND ${NON_MERGE_COMMIT_SQL}`,
      )
      .get(repository, sha)
  )
    throw new LocalStateError("Commit not found", 404);
  const analysis = attributionStatus(store, w.id);
  const commit = analysis.runId
    ? (db
        .prepare(
          "SELECT * FROM adit_attribution_commits WHERE run_id=? AND repository=? AND sha=?",
        )
        .get(analysis.runId, repository, sha) as Row | undefined)
    : undefined;
  if (!commit)
    return {
      analysis,
      eligible: null,
      matched: null,
      moved: null,
      unknown: null,
      excluded: null,
      sources: [],
      coverage: "",
    };
  const groups = db
    .prepare(
      `SELECT l.provider,l.session_id,s.title,s.first_prompt,sum(l.certain_lines) certain,sum(l.likely_lines) likely,sum(l.possible_lines) possible FROM adit_attribution_writers l LEFT JOIN adit_history_sessions s ON s.provider=l.provider AND s.id=l.session_id WHERE l.run_id=? AND l.repository=? AND l.sha=? AND l.provider IS NOT NULL GROUP BY l.provider,l.session_id ORDER BY sum(l.certain_lines+l.likely_lines+l.possible_lines) DESC,l.provider,l.session_id`,
    )
    .all(analysis.runId, repository, sha) as Row[];
  const sources = groups.map((s) => ({
    provider: s.provider,
    sessionId: s.session_id,
    title: redactOverview(s.title || s.first_prompt || "—"),
    certain: s.certain,
    likely: s.likely,
    possible: s.possible,
    files: db
      .prepare(
        "SELECT file_path path,sum(certain_lines+likely_lines+possible_lines) lines FROM adit_attribution_writers WHERE run_id=? AND repository=? AND sha=? AND provider=? AND session_id=? GROUP BY file_path ORDER BY lines DESC,file_path",
      )
      .all(analysis.runId, repository, sha, s.provider, s.session_id),
    alternatives: (
      db
        .prepare(
          `SELECT DISTINCT c.provider,c.session_id,s.title,s.first_prompt FROM adit_attribution_alternatives c LEFT JOIN adit_history_sessions s ON s.provider=c.provider AND s.id=c.session_id WHERE c.run_id=? AND c.repository=? AND c.sha=? AND c.writer_provider=? AND c.writer_session_id=? ORDER BY c.provider,c.session_id`,
        )
        .all(analysis.runId, repository, sha, s.provider, s.session_id) as Row[]
    ).map((a) => ({
      provider: a.provider,
      sessionId: a.session_id,
      title: redactOverview(a.title || a.first_prompt || "—"),
    })),
  }));
  return {
    analysis,
    eligible: commit.eligible_lines,
    excluded: commit.excluded_lines,
    matched: commit.certain_lines + commit.likely_lines + commit.possible_lines,
    moved: commit.moved_lines,
    unknown: commit.unknown_lines,
    sources,
    coverage:
      analysis.missingTimes || analysis.missingBackups
        ? `缺少时间的写入记录 ${analysis.missingTimes} 条；无法读取的备份 ${analysis.missingBackups} 个。缺失部分不推断归属。`
        : "",
  };
}
