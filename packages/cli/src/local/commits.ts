import {
  redactOverview,
  NON_MERGE_COMMIT_SQL,
  type LocalStore,
  type LocalWorkspace,
} from "@varveai/adit-core";
import { attributionStatus } from "./commit-sources.js";
type Row = Record<string, any>;

/** Git records the branch in its successful commit output, not in the commit object. */
export function branchFromCommitOutput(
  outputs: readonly string[],
  sha: string,
): string | null {
  const branches = new Set<string | null>();
  for (const output of outputs) {
    for (const match of output.matchAll(
      /\[([^\[\r\n]+?)\s+([a-f0-9]{7,64})\]/g,
    )) {
      if (!sha.startsWith(match[2])) continue;
      const branch = match[1].replace(/\s+\(root-commit\)$/, "");
      // Detached HEAD is a checkout state, not a branch. Conflicting evidence stays unknown.
      branches.add(
        /^[^\s\[\]]+$/.test(branch) && branch !== "HEAD" ? branch : null,
      );
    }
  }
  return branches.size === 1 ? [...branches][0] : null;
}

export interface CommitQuery {
  sha?: string;
  repository?: string;
  session?: { provider: string; ids: string[] };
  limit?: number;
  offset?: number;
}
export function queryCommits(store: Pick<LocalStore, "db">, w: LocalWorkspace, options: CommitQuery = {}) {
  return store.db.transaction(() => readCommits(store, w, options))();
}
function readCommits(store: Pick<LocalStore, "db">, w: LocalWorkspace, options: CommitQuery) {
  const db = store.db,
    analysis = attributionStatus(store, w.id);
  const results = db.prepare(
    "SELECT content_text FROM adit_history_tool_results WHERE tool_call_id=? ORDER BY event_index",
  );
  const outputsByCall = new Map<string, string[]>();
  const from = `FROM adit_local_commits c LEFT JOIN adit_attribution_commits a ON a.repository=c.repository AND a.sha=c.sha AND a.run_id=@run
    WHERE c.repository IN (SELECT value FROM json_each(@repositories)) AND ${NON_MERGE_COMMIT_SQL}
      AND (@sha IS NULL OR c.sha LIKE @sha) AND (@repository IS NULL OR c.repository=@repository)
      AND (@provider IS NULL OR (a.submit_provider=@provider AND a.submit_session_id IN (SELECT value FROM json_each(@sessions)))
        OR EXISTS(SELECT 1 FROM adit_attribution_lines l WHERE l.run_id=@run AND l.repository=c.repository AND l.sha=c.sha
          AND l.provider=@provider AND l.session_id IN (SELECT value FROM json_each(@sessions))))`;
  const params = { run: analysis.runId, repositories: JSON.stringify(w.repositories), sha: options.sha ? options.sha + "%" : null,
    repository: options.repository ?? null, provider: options.session?.provider ?? null, sessions: JSON.stringify(options.session?.ids ?? []) };
  const total = (db.prepare(`SELECT count(*) n ${from}`).get(params) as Row).n as number;
  const offset = options.offset ?? 0;
  const commits = db.prepare(`SELECT c.*,a.submit_provider,a.submit_session_id,a.submit_turn_id,a.submit_tool_call_id,a.match_method,a.matched_sha,a.eligible_lines
    ${from} ORDER BY c.authored_at DESC,c.sha,c.repository LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: options.limit ?? -1, offset }) as Row[];
  return {
    repositories: w.repositories,
    analysis,
    total,
    nextOffset: offset + commits.length < total ? offset + commits.length : null,
    commits: commits
      .map((c) => {
        let branch: string | null = null;
        if (c.match_method === "hash" && c.submit_tool_call_id) {
          let outputs = outputsByCall.get(c.submit_tool_call_id);
          if (!outputs) {
            outputs = (results.all(c.submit_tool_call_id) as Row[]).map(
              (r) => r.content_text || "",
            );
            outputsByCall.set(c.submit_tool_call_id, outputs);
          }
          branch = branchFromCommitOutput(outputs, c.sha);
        }
        const record = c.submit_session_id
          ? (db
              .prepare(
                `SELECT s.title,s.first_prompt,t.command_text,t.occurred_at,turn.ordinal,(SELECT group_concat(b.text_content,' ') FROM adit_history_blocks b WHERE b.message_id=turn.prompt_message_id) prompt FROM adit_history_sessions s LEFT JOIN adit_history_tool_calls t ON t.id=? LEFT JOIN adit_history_turns turn ON turn.id=? WHERE s.provider=? AND s.id=?`,
              )
              .get(
                c.submit_tool_call_id,
                c.submit_turn_id,
                c.submit_provider,
                c.submit_session_id,
              ) as Row | undefined)
          : undefined;
        const count =
          c.eligible_lines === null
            ? null
            : (
                db
                  .prepare(
                    "SELECT count(*) n FROM (SELECT provider,session_id FROM adit_attribution_lines WHERE run_id=? AND repository=? AND sha=? AND provider IS NOT NULL GROUP BY provider,session_id)",
                  )
                  .get(analysis.runId, c.repository, c.sha) as Row
              ).n;
        return {
          repository: c.repository,
          sha: c.sha,
          subject: redactOverview(c.subject),
          authoredAt: c.authored_at,
          branch,
          analyzed: c.eligible_lines !== null,
          sourceCount: count,
          files: db
            .prepare(
              "SELECT path,additions,deletions,binary FROM adit_local_commit_files WHERE repository=? AND sha=? ORDER BY ordinal",
            )
            .all(c.repository, c.sha),
          record: record
            ? {
                provider: c.submit_provider,
                sessionId: c.submit_session_id,
                turnId: c.submit_turn_id,
                title: redactOverview(
                  record.title || record.first_prompt || "—",
                ),
                ordinal: record.ordinal,
                at: record.occurred_at,
                command: redactOverview(record.command_text || ""),
                prompt: redactOverview(record.prompt || ""),
                method: c.match_method,
                matchedSha: c.matched_sha,
              }
            : null,
        };
      })
      .sort(
        (a, b) =>
          (b.authoredAt || 0) - (a.authoredAt || 0) ||
          a.sha.localeCompare(b.sha),
      ),
  };
}
