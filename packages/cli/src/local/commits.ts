import {
  redactOverview,
  NON_MERGE_COMMIT_SQL,
  type LocalStore,
  type LocalWorkspace,
} from "@varveai/adit-core";
import { attributionStatus } from "./commit-sources.js";
type Row = Record<string, any>;
export function queryCommits(store: LocalStore, w: LocalWorkspace) {
  return store.db.transaction(() => readCommits(store, w))();
}
function readCommits(store: LocalStore, w: LocalWorkspace) {
  const db = store.db,
    analysis = attributionStatus(store, w.id);
  const commits = w.repositories.flatMap(
    (repository) =>
      db
        .prepare(
          `SELECT c.*,a.submit_provider,a.submit_session_id,a.submit_turn_id,a.submit_tool_call_id,a.match_method,a.matched_sha,a.eligible_lines FROM adit_local_commits c LEFT JOIN adit_attribution_commits a ON a.repository=c.repository AND a.sha=c.sha AND a.run_id=? WHERE c.repository=? AND ${NON_MERGE_COMMIT_SQL}`,
        )
        .all(analysis.runId, repository) as Row[],
  );
  return {
    repositories: w.repositories,
    analysis,
    commits: commits
      .map((c) => {
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
