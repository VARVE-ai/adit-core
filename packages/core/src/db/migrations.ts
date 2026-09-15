/**
 * SQLite schema migrations for ADIT.
 *
 * Migrations are applied in order. Each migration has an id and SQL.
 * The migrations table tracks which have been applied.
 */

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "create_sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL,
        client_id     TEXT NOT NULL,
        session_type  TEXT NOT NULL DEFAULT 'interactive',
        platform      TEXT NOT NULL DEFAULT 'other',
        started_at    TEXT NOT NULL,
        ended_at      TEXT,
        status        TEXT NOT NULL DEFAULT 'active',
        metadata_json TEXT,
        vclock_json   TEXT NOT NULL,
        deleted_at    TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_project
        ON sessions(project_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status
        ON sessions(status) WHERE deleted_at IS NULL;
    `,
  },
  {
    id: 2,
    name: "create_events",
    sql: `
      CREATE TABLE IF NOT EXISTS events (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES sessions(id),
        parent_event_id TEXT REFERENCES events(id),
        sequence        INTEGER NOT NULL,
        event_type      TEXT NOT NULL,
        actor           TEXT NOT NULL,

        prompt_text     TEXT,
        cot_text        TEXT,
        response_text   TEXT,

        tool_name       TEXT,
        tool_input_json TEXT,
        tool_output_json TEXT,

        checkpoint_sha  TEXT,
        checkpoint_ref  TEXT,
        diff_stat_json  TEXT,

        git_branch      TEXT,
        git_head_sha    TEXT,
        env_snapshot_id TEXT,

        started_at      TEXT NOT NULL,
        ended_at        TEXT,
        status          TEXT NOT NULL DEFAULT 'running',
        error_json      TEXT,
        labels_json     TEXT,

        vclock_json     TEXT NOT NULL,
        deleted_at      TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_session
        ON events(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_type
        ON events(event_type) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_events_checkpoint
        ON events(checkpoint_sha) WHERE checkpoint_sha IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_events_actor
        ON events(actor) WHERE deleted_at IS NULL;
    `,
  },
  {
    id: 3,
    name: "create_env_snapshots",
    sql: `
      CREATE TABLE IF NOT EXISTS env_snapshots (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES sessions(id),
        git_branch      TEXT NOT NULL,
        git_head_sha    TEXT NOT NULL,
        modified_files  TEXT,
        dep_lock_hash   TEXT,
        dep_lock_path   TEXT,
        env_vars_json   TEXT,
        node_version    TEXT,
        python_version  TEXT,
        os_info         TEXT,
        captured_at     TEXT NOT NULL,
        vclock_json     TEXT NOT NULL,
        deleted_at      TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_env_session
        ON env_snapshots(session_id);
    `,
  },
  // Migration 4 belonged to the retired local Plan model. Its ID remains
  // reserved so databases created by older releases keep their migration
  // history; their unused table is intentionally left intact for recovery.
  {
    id: 5,
    name: "create_diffs",
    sql: `
      CREATE TABLE IF NOT EXISTS diffs (
        id          TEXT PRIMARY KEY,
        event_id    TEXT NOT NULL REFERENCES events(id),
        diff_text   TEXT NOT NULL,
        file_filter TEXT,
        created_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_diffs_event
        ON diffs(event_id);
    `,
  },
  {
    id: 6,
    name: "add_env_snapshot_enrichment",
    sql: `
      ALTER TABLE env_snapshots ADD COLUMN container_info TEXT;
      ALTER TABLE env_snapshots ADD COLUMN runtime_versions_json TEXT;
      ALTER TABLE env_snapshots ADD COLUMN shell_info TEXT;
      ALTER TABLE env_snapshots ADD COLUMN system_resources_json TEXT;
      ALTER TABLE env_snapshots ADD COLUMN package_manager_json TEXT;
    `,
  },
  {
    id: 7,
    name: "create_sync_state",
    sql: `
      CREATE TABLE IF NOT EXISTS sync_state (
        server_url            TEXT PRIMARY KEY,
        client_id             TEXT NOT NULL,
        last_synced_event_id  TEXT,
        last_synced_at        TEXT,
        sync_version          INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  // Migration 8 belonged to the retired transcript upload feature. Its ID
  // remains reserved so existing databases keep a stable migration history.
  {
    id: 9,
    name: "add_events_client_id_and_started_at_index",
    sql: `
      ALTER TABLE events ADD COLUMN client_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_events_started_at
        ON events(started_at) WHERE deleted_at IS NULL;
    `,
  },
  {
    id: 10,
    name: "add_sessions_platform_session_id",
    sql: `
      ALTER TABLE sessions ADD COLUMN platform_session_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_sessions_platform_session_id
        ON sessions(platform_session_id) WHERE platform_session_id IS NOT NULL;
    `,
  },
  {
    id: 11,
    name: "create_project_link_cache",
    sql: `
      CREATE TABLE IF NOT EXISTS project_link_cache (
        project_id TEXT NOT NULL,
        server_url TEXT NOT NULL,
        confirmed_project_id TEXT,
        last_commit_sha TEXT,
        last_branch_sync_at TEXT,
        last_doc_sync_at TEXT,
        doc_hashes_json TEXT DEFAULT '{}',
        qualified INTEGER DEFAULT 0,
        initialized_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, server_url)
      );
    `,
  },
  {
    id: 12,
    name: "add_project_link_cache_repository_id",
    sql: `
      ALTER TABLE project_link_cache RENAME TO project_link_cache_old;

      CREATE TABLE project_link_cache (
        project_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        server_url TEXT NOT NULL,
        confirmed_project_id TEXT,
        last_commit_sha TEXT,
        last_branch_sync_at TEXT,
        last_doc_sync_at TEXT,
        doc_hashes_json TEXT DEFAULT '{}',
        qualified INTEGER DEFAULT 0,
        initialized_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, repository_id, server_url)
      );

      INSERT INTO project_link_cache (
        project_id, repository_id, server_url, confirmed_project_id,
        last_commit_sha, last_branch_sync_at, last_doc_sync_at,
        doc_hashes_json, qualified, initialized_at, updated_at
      )
      SELECT
        project_id, project_id, server_url, confirmed_project_id,
        last_commit_sha, last_branch_sync_at, last_doc_sync_at,
        doc_hashes_json, qualified, initialized_at, updated_at
      FROM project_link_cache_old;

      DROP TABLE project_link_cache_old;
    `,
  },
  {
    id: 13,
    name: "create_session_repo_heads",
    sql: `
      CREATE TABLE IF NOT EXISTS session_repo_heads (
        session_id    TEXT NOT NULL REFERENCES sessions(id),
        relative_path TEXT NOT NULL,
        last_sha      TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (session_id, relative_path)
      );
    `,
  },
  {
    id: 14,
    name: "drop_transcript_uploads",
    sql: "DROP TABLE IF EXISTS transcript_uploads;",
  },
  {
    id: 15,
    name: "drop_session_lifecycle",
    sql: `
      DROP INDEX IF EXISTS idx_sessions_status;
      ALTER TABLE sessions DROP COLUMN ended_at;
      ALTER TABLE sessions DROP COLUMN status;
    `,
  },
  {
    id: 16,
    name: "add_project_link_git_state",
    sql: `
      ALTER TABLE project_link_cache
        ADD COLUMN git_ref_heads_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE project_link_cache
        ADD COLUMN git_refs_fingerprint TEXT;
    `,
  },
  {
    id: 17,
    name: "replace_commit_observation_with_recorded_commits",
    sql: `
      DROP TABLE IF EXISTS session_repo_heads;

      DROP INDEX IF EXISTS idx_events_checkpoint;
      ALTER TABLE events DROP COLUMN checkpoint_sha;
      ALTER TABLE events DROP COLUMN checkpoint_ref;

      ALTER TABLE project_link_cache DROP COLUMN last_commit_sha;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_git_commit_identity
        ON events(
          session_id,
          event_type,
          json_extract(tool_input_json, '$.provider'),
          json_extract(tool_input_json, '$.toolCallId'),
          json_extract(tool_input_json, '$.operationIndex')
        )
        WHERE event_type = 'git_commit'
          AND tool_name = 'commit'
          AND deleted_at IS NULL;
    `,
  },
  {
    id: 18,
    name: "normalize_cloud_server_urls",
    sql: `
      ALTER TABLE sync_state RENAME TO sync_state_legacy_urls;

      CREATE TABLE sync_state (
        server_url            TEXT PRIMARY KEY,
        client_id             TEXT NOT NULL,
        last_synced_event_id  TEXT,
        last_synced_at        TEXT,
        sync_version          INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO sync_state (
        server_url, client_id, last_synced_event_id, last_synced_at, sync_version
      )
      WITH normalized AS (
        SELECT
          RTRIM(TRIM(server_url), '/') AS server_url,
          client_id,
          last_synced_event_id,
          last_synced_at,
          sync_version
        FROM sync_state_legacy_urls
      ), ranked AS (
        SELECT
          server_url,
          client_id,
          MAX(last_synced_event_id) OVER (PARTITION BY server_url) AS last_synced_event_id,
          MAX(last_synced_at) OVER (PARTITION BY server_url) AS last_synced_at,
          MAX(sync_version) OVER (PARTITION BY server_url) AS sync_version,
          ROW_NUMBER() OVER (
            PARTITION BY server_url
            ORDER BY COALESCE(last_synced_at, '') DESC, sync_version DESC
          ) AS row_number
        FROM normalized
      )
      SELECT server_url, client_id, last_synced_event_id, last_synced_at, sync_version
      FROM ranked
      WHERE row_number = 1;

      DROP TABLE sync_state_legacy_urls;

      ALTER TABLE project_link_cache RENAME TO project_link_cache_legacy_urls;

      CREATE TABLE project_link_cache (
        project_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        server_url TEXT NOT NULL,
        confirmed_project_id TEXT,
        last_branch_sync_at TEXT,
        last_doc_sync_at TEXT,
        doc_hashes_json TEXT DEFAULT '{}',
        qualified INTEGER DEFAULT 0,
        initialized_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        git_ref_heads_json TEXT NOT NULL DEFAULT '{}',
        git_refs_fingerprint TEXT,
        PRIMARY KEY (project_id, repository_id, server_url)
      );

      INSERT INTO project_link_cache (
        project_id, repository_id, server_url, confirmed_project_id,
        last_branch_sync_at, last_doc_sync_at, doc_hashes_json, qualified,
        initialized_at, updated_at, git_ref_heads_json, git_refs_fingerprint
      )
      WITH normalized AS (
        SELECT
          project_id,
          repository_id,
          RTRIM(TRIM(server_url), '/') AS server_url,
          confirmed_project_id,
          last_branch_sync_at,
          last_doc_sync_at,
          doc_hashes_json,
          qualified,
          initialized_at,
          updated_at,
          git_ref_heads_json,
          git_refs_fingerprint
        FROM project_link_cache_legacy_urls
      ), merged AS (
        SELECT DISTINCT
          project_id,
          repository_id,
          server_url,
          FIRST_VALUE(confirmed_project_id) OVER confirmed_state AS confirmed_project_id,
          FIRST_VALUE(last_branch_sync_at) OVER branch_state AS last_branch_sync_at,
          FIRST_VALUE(last_doc_sync_at) OVER document_state AS last_doc_sync_at,
          FIRST_VALUE(doc_hashes_json) OVER document_state AS doc_hashes_json,
          MAX(qualified) OVER cache_key AS qualified,
          MIN(initialized_at) OVER cache_key AS initialized_at,
          MAX(updated_at) OVER cache_key AS updated_at,
          FIRST_VALUE(git_ref_heads_json) OVER branch_state AS git_ref_heads_json,
          FIRST_VALUE(git_refs_fingerprint) OVER branch_state AS git_refs_fingerprint
        FROM normalized
        WINDOW
          cache_key AS (
            PARTITION BY project_id, repository_id, server_url
          ),
          confirmed_state AS (
            PARTITION BY project_id, repository_id, server_url
            ORDER BY (confirmed_project_id IS NULL), updated_at DESC
          ),
          branch_state AS (
            PARTITION BY project_id, repository_id, server_url
            ORDER BY
              (git_refs_fingerprint IS NULL AND git_ref_heads_json = '{}'),
              COALESCE(last_branch_sync_at, '') DESC,
              updated_at DESC
          ),
          document_state AS (
            PARTITION BY project_id, repository_id, server_url
            ORDER BY
              (last_doc_sync_at IS NULL AND doc_hashes_json = '{}'),
              COALESCE(last_doc_sync_at, '') DESC,
              updated_at DESC
          )
      )
      SELECT
        project_id, repository_id, server_url, confirmed_project_id,
        last_branch_sync_at, last_doc_sync_at, doc_hashes_json, qualified,
        initialized_at, updated_at, git_ref_heads_json, git_refs_fingerprint
      FROM merged;

      DROP TABLE project_link_cache_legacy_urls;
    `,
  },
  {
    id: 19,
    name: "replace_git_operation_identity_with_commit_identity",
    sql: `
      DROP INDEX IF EXISTS idx_events_git_operation_identity;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_git_commit_identity
        ON events(
          session_id,
          event_type,
          json_extract(tool_input_json, '$.provider'),
          json_extract(tool_input_json, '$.toolCallId'),
          json_extract(tool_input_json, '$.operationIndex')
        )
        WHERE event_type = 'git_commit'
          AND tool_name = 'commit'
          AND deleted_at IS NULL;
    `,
  },
  {
    id: 20,
    name: "add_project_link_remote_branch_state",
    sql: `
      ALTER TABLE project_link_cache
        ADD COLUMN remote_refs_fingerprint TEXT;
      ALTER TABLE project_link_cache
        ADD COLUMN last_remote_branch_check_at TEXT;
    `,
  },
  {
    id: 21,
    name: "create_session_platform_aliases",
    sql: `
      -- Extra platform session ids that belong to an existing local session.
      -- Claude Code forks a conversation into a new session id when a
      -- message is edited and resent; the fork keeps recording here.
      CREATE TABLE IF NOT EXISTS session_platform_aliases (
        platform_session_id TEXT PRIMARY KEY,
        session_id          TEXT NOT NULL REFERENCES sessions(id),
        created_at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_platform_aliases_session
        ON session_platform_aliases(session_id);
    `,
  },
  {
    id: 22,
    name: "add_event_inferred_files",
    sql: `
      -- Files a turn changed without a file-editing tool (e.g. Claude's Bash
      -- writes), inferred from working-tree snapshots taken around each tool
      -- call. Path-only evidence for commit matching; never a diff.
      ALTER TABLE events ADD COLUMN inferred_files_json TEXT;
    `,
  },
];
