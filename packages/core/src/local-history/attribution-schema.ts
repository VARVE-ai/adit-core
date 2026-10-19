import type Database from "better-sqlite3";

/** Derived analysis only. Native sessions are never merged, rewritten or removed here. */
export function createAttributionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS adit_attribution_runs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, algorithm_version INTEGER NOT NULL,
      input_fingerprint TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL,
      finished_at INTEGER, error TEXT, commit_count INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0, missing_time_count INTEGER NOT NULL DEFAULT 0,
      missing_backup_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS adit_attribution_runs_workspace ON adit_attribution_runs(workspace_id,started_at DESC);
    CREATE TABLE IF NOT EXISTS adit_attribution_evidence (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES adit_attribution_runs(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT, tool_call_id TEXT,
      source_kind TEXT NOT NULL, source_path TEXT, file_path TEXT, occurred_at INTEGER NOT NULL,
      line_text TEXT NOT NULL, line_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS adit_attribution_evidence_hash ON adit_attribution_evidence(run_id,line_hash,occurred_at);
    CREATE TABLE IF NOT EXISTS adit_attribution_commits (
      run_id TEXT NOT NULL REFERENCES adit_attribution_runs(id) ON DELETE CASCADE,
      repository TEXT NOT NULL, sha TEXT NOT NULL,
      submit_provider TEXT, submit_session_id TEXT, submit_turn_id TEXT, submit_tool_call_id TEXT,
      match_method TEXT, matched_sha TEXT,
      eligible_lines INTEGER NOT NULL, excluded_lines INTEGER NOT NULL,
      certain_lines INTEGER NOT NULL, likely_lines INTEGER NOT NULL, possible_lines INTEGER NOT NULL,
      moved_lines INTEGER NOT NULL, unknown_lines INTEGER NOT NULL,
      PRIMARY KEY(run_id,repository,sha)
    );
    CREATE TABLE IF NOT EXISTS adit_attribution_lines (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES adit_attribution_runs(id) ON DELETE CASCADE,
      repository TEXT NOT NULL, sha TEXT NOT NULL, file_path TEXT NOT NULL, line_number INTEGER NOT NULL,
      hunk INTEGER NOT NULL, line_hash TEXT NOT NULL, tier TEXT NOT NULL,
      provider TEXT, session_id TEXT, evidence_id TEXT, match_method TEXT, similarity REAL,
      UNIQUE(run_id,repository,sha,file_path,line_number)
    );
    CREATE INDEX IF NOT EXISTS adit_attribution_lines_commit ON adit_attribution_lines(run_id,repository,sha,provider,session_id,tier);
    CREATE TABLE IF NOT EXISTS adit_attribution_candidates (
      line_id TEXT NOT NULL REFERENCES adit_attribution_lines(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, session_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
      hunk_support INTEGER NOT NULL, occurred_at INTEGER NOT NULL, selected INTEGER NOT NULL,
      PRIMARY KEY(line_id,provider,session_id)
    );
    CREATE INDEX IF NOT EXISTS adit_attribution_candidates_evidence ON adit_attribution_candidates(evidence_id);
  `);
}
