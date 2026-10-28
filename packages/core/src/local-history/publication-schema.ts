import type Database from "better-sqlite3";

/** Published artifacts deliberately have no cascading references to collected history. */
export function createPublicationSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS adit_shares (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, provider TEXT NOT NULL, session_id TEXT NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, published_at INTEGER,
      current_version_id TEXT NOT NULL, remote_id TEXT, remote_url TEXT, viewer_url TEXT, remote_revision TEXT,
      last_error TEXT, prompt_count INTEGER NOT NULL, commit_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS adit_shares_list ON adit_shares(workspace_id,status,published_at DESC,id);
    CREATE INDEX IF NOT EXISTS adit_shares_source ON adit_shares(workspace_id,provider,session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS adit_shares_remote ON adit_shares(remote_id) WHERE remote_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS adit_share_versions (
      id TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES adit_shares(id), source_revision INTEGER NOT NULL,
      policy_version INTEGER NOT NULL, scope_kind TEXT NOT NULL, title TEXT NOT NULL,
      include_dialogue INTEGER NOT NULL, include_commands INTEGER NOT NULL, include_commits INTEGER NOT NULL,
      include_outputs INTEGER NOT NULL, include_thinking INTEGER NOT NULL, include_cost INTEGER NOT NULL,
      snapshot_digest TEXT NOT NULL, snapshot_json TEXT NOT NULL, markdown TEXT NOT NULL,
      options_json TEXT NOT NULL, review_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS adit_share_versions_share ON adit_share_versions(share_id);
    CREATE TABLE IF NOT EXISTS adit_share_turns (
      version_id TEXT NOT NULL REFERENCES adit_share_versions(id), turn_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      PRIMARY KEY(version_id,turn_id)
    );
    CREATE TABLE IF NOT EXISTS adit_share_redactions (
      id INTEGER PRIMARY KEY, version_id TEXT NOT NULL REFERENCES adit_share_versions(id), field_path TEXT NOT NULL,
      rule_id TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, replacement_kind TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS adit_share_commits (
      version_id TEXT NOT NULL REFERENCES adit_share_versions(id), repository TEXT NOT NULL, commit_sha TEXT NOT NULL,
      ordinal INTEGER NOT NULL, source_turn_id TEXT, PRIMARY KEY(version_id,repository,commit_sha)
    );
    CREATE INDEX IF NOT EXISTS adit_share_redactions_version ON adit_share_redactions(version_id,rule_id);
    CREATE TABLE IF NOT EXISTS adit_share_publish_attempts (
      idempotency_key TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES adit_share_versions(id),
      status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, remote_id TEXT, error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS adit_share_attempts_version ON adit_share_publish_attempts(version_id);
    CREATE TABLE IF NOT EXISTS adit_pr_descriptions (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, repository TEXT NOT NULL, title TEXT NOT NULL,
      scope_kind TEXT NOT NULL, source_ref TEXT, target_ref TEXT, source_head_sha TEXT, target_head_sha TEXT,
      merge_base_sha TEXT, scope_digest TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      generation_version INTEGER NOT NULL, attribution_version INTEGER, detail_level TEXT NOT NULL, language TEXT NOT NULL,
      template_ref TEXT, template_digest TEXT, include_session_ids INTEGER NOT NULL, include_line_stats INTEGER NOT NULL,
      include_assisted_by INTEGER NOT NULL, include_prompts INTEGER NOT NULL, include_share_links INTEGER NOT NULL,
      include_adit_label INTEGER NOT NULL, author_filter TEXT NOT NULL, merge_policy TEXT NOT NULL,
      commit_count INTEGER NOT NULL, session_count INTEGER NOT NULL, unmatched_count INTEGER NOT NULL,
      excluded_merge_count INTEGER NOT NULL, excluded_author_count INTEGER NOT NULL,
      markdown TEXT NOT NULL, snapshot_json TEXT NOT NULL, error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS adit_pr_descriptions_list ON adit_pr_descriptions(workspace_id,status,created_at DESC,id);
    CREATE TABLE IF NOT EXISTS adit_pr_description_jobs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, request_key TEXT NOT NULL, request_digest TEXT NOT NULL,
      status TEXT NOT NULL, result_id TEXT, error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER,
      UNIQUE(workspace_id,request_key)
    );
    CREATE TABLE IF NOT EXISTS adit_pr_description_commits (
      description_id TEXT NOT NULL REFERENCES adit_pr_descriptions(id), repository TEXT NOT NULL, commit_sha TEXT NOT NULL,
      ordinal INTEGER NOT NULL, subject_snapshot TEXT NOT NULL, inclusion_status TEXT NOT NULL, exclusion_reason TEXT,
      analysis_status TEXT NOT NULL, submit_provider TEXT, submit_session_id TEXT, submit_turn_id TEXT, match_method TEXT,
      eligible_lines INTEGER, excluded_lines INTEGER, certain_lines INTEGER, likely_lines INTEGER,
      possible_lines INTEGER, moved_lines INTEGER, unknown_lines INTEGER,
      PRIMARY KEY(description_id,repository,commit_sha)
    );
    CREATE INDEX IF NOT EXISTS adit_pr_commit_history ON adit_pr_description_commits(repository,commit_sha,description_id);
    CREATE TABLE IF NOT EXISTS adit_pr_description_sessions (
      description_id TEXT NOT NULL REFERENCES adit_pr_descriptions(id), provider TEXT NOT NULL, session_id TEXT NOT NULL,
      display_number INTEGER NOT NULL, transcript_revision INTEGER, prompt_count INTEGER, work_duration_ms INTEGER,
      PRIMARY KEY(description_id,provider,session_id)
    );
    CREATE TABLE IF NOT EXISTS adit_pr_description_commit_sessions (
      description_id TEXT NOT NULL REFERENCES adit_pr_descriptions(id), commit_sha TEXT NOT NULL, provider TEXT NOT NULL,
      session_id TEXT NOT NULL, role TEXT NOT NULL, certain_lines INTEGER, likely_lines INTEGER, possible_lines INTEGER,
      PRIMARY KEY(description_id,commit_sha,provider,session_id,role)
    );
    CREATE TABLE IF NOT EXISTS adit_pr_description_usage (
      description_id TEXT NOT NULL REFERENCES adit_pr_descriptions(id), source_usage_entry_id TEXT NOT NULL,
      provider TEXT NOT NULL, session_id TEXT NOT NULL, model TEXT, inclusion_scope TEXT NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER, total_tokens INTEGER, cost_microusd INTEGER, completeness TEXT NOT NULL,
      PRIMARY KEY(description_id,source_usage_entry_id)
    );
    CREATE TABLE IF NOT EXISTS adit_pr_description_models (
      description_id TEXT NOT NULL REFERENCES adit_pr_descriptions(id), provider TEXT NOT NULL, session_id TEXT NOT NULL,
      model TEXT NOT NULL, evidence_scope TEXT NOT NULL, PRIMARY KEY(description_id,provider,session_id,model,evidence_scope)
    );
    CREATE TABLE IF NOT EXISTS adit_pr_description_share_links (
      description_id TEXT NOT NULL REFERENCES adit_pr_descriptions(id), provider TEXT NOT NULL, session_id TEXT NOT NULL,
      share_version_id TEXT NOT NULL, url_snapshot TEXT NOT NULL, coverage_kind TEXT NOT NULL,
      PRIMARY KEY(description_id,provider,session_id,share_version_id)
    );
    CREATE TABLE IF NOT EXISTS adit_pr_description_prompts (
      description_id TEXT NOT NULL REFERENCES adit_pr_descriptions(id), provider TEXT NOT NULL, session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL, ordinal INTEGER NOT NULL, sanitized_text TEXT NOT NULL, redaction_policy_version INTEGER NOT NULL,
      PRIMARY KEY(description_id,provider,session_id,turn_id)
    );
  `);
}

export function insertPublication(db: Database.Database, table: string, values: Record<string, unknown>) {
  // All table and column identifiers are internal constants, never request values.
  const keys = Object.keys(values);
  db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .run(...keys.map(key => values[key] ?? null));
}
