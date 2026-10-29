import type Database from "better-sqlite3";
import { createAttributionSchema } from './attribution-schema.js';
import { createInspectionSchema, registerHistoryRedaction } from './inspection-schema.js';
import { removeHistorySearchIndex } from './history-search.js';

/** Fresh development schema. Older JSON archives must be explicitly reset, never migrated here. */
export function createHistorySchema(db: Database.Database): void {
  registerHistoryRedaction(db);
  const columns = db.prepare("PRAGMA table_info(adit_history_sessions)").all() as { name: string }[];
  if (columns.some(column => column.name === "data"))
    throw new Error("The development history schema changed. Clear collected local history and collect again; automatic migration is disabled.");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS adit_history_sessions (
      provider TEXT NOT NULL, id TEXT NOT NULL, cwd TEXT NOT NULL, parent_id TEXT,
      relationship TEXT, title TEXT, first_prompt TEXT, started_at INTEGER, last_activity_at INTEGER,
      message_count INTEGER NOT NULL, user_prompt_count INTEGER NOT NULL,
      metadata_json TEXT, extra_json TEXT NOT NULL, transcript_revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(provider,id)
    );
    CREATE INDEX IF NOT EXISTS adit_history_session_activity ON adit_history_sessions(last_activity_at DESC,provider,id);
    CREATE INDEX IF NOT EXISTS adit_history_session_scope ON adit_history_sessions(cwd,provider,last_activity_at DESC);
    CREATE TABLE IF NOT EXISTS adit_history_deleted_turns (
      provider TEXT NOT NULL, session_id TEXT NOT NULL, prompt_key TEXT NOT NULL, deleted_at INTEGER NOT NULL,
      PRIMARY KEY(provider,session_id,prompt_key),
      FOREIGN KEY(provider,session_id) REFERENCES adit_history_sessions(provider,id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS adit_history_text_edits (
      provider TEXT NOT NULL, session_id TEXT NOT NULL, message_key TEXT NOT NULL,
      block_index INTEGER NOT NULL, text_content TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(provider,session_id,message_key,block_index),
      FOREIGN KEY(provider,session_id) REFERENCES adit_history_sessions(provider,id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS adit_history_sources (
      provider TEXT NOT NULL, path TEXT NOT NULL, session_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, parser_version INTEGER NOT NULL,
      PRIMARY KEY(provider,path),
      FOREIGN KEY(provider,session_id) REFERENCES adit_history_sessions(provider,id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS adit_history_sources_session ON adit_history_sources(provider,session_id);
    CREATE TABLE IF NOT EXISTS adit_history_file_checkpoints (
      provider TEXT NOT NULL, path TEXT NOT NULL, scope TEXT NOT NULL, parser_version INTEGER NOT NULL,
      manifest_json TEXT NOT NULL, sessions_json TEXT NOT NULL, PRIMARY KEY(provider,path,scope)
    );
    CREATE TABLE IF NOT EXISTS adit_history_assignments (
      provider TEXT NOT NULL, session_id TEXT NOT NULL, workspace TEXT NOT NULL,
      PRIMARY KEY(provider,session_id),
      FOREIGN KEY(provider,session_id) REFERENCES adit_history_sessions(provider,id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS adit_history_jsonl_cursors (
      provider TEXT NOT NULL,path TEXT NOT NULL,scope TEXT NOT NULL,parser_version INTEGER NOT NULL,
      session_id TEXT NOT NULL,byte_offset INTEGER NOT NULL,prefix_hash TEXT NOT NULL,file_identity TEXT NOT NULL,state_json TEXT NOT NULL,
      PRIMARY KEY(provider,path,scope),
      FOREIGN KEY(provider,path,scope) REFERENCES adit_history_file_checkpoints(provider,path,scope) ON DELETE CASCADE,
      FOREIGN KEY(provider,session_id) REFERENCES adit_history_sessions(provider,id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS adit_history_cursor_session ON adit_history_jsonl_cursors(provider,session_id);
    CREATE TABLE IF NOT EXISTS adit_history_messages (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, session_id TEXT NOT NULL,
      source_key TEXT NOT NULL, ordinal INTEGER NOT NULL, role TEXT NOT NULL,
      parent_key TEXT, turn_id TEXT, occurred_at INTEGER, source_timestamp TEXT,
      model TEXT, effort TEXT, request_id TEXT, response_id TEXT,
      content_json TEXT, raw_json TEXT NOT NULL, extra_json TEXT NOT NULL,
      UNIQUE(provider,session_id,source_key), UNIQUE(provider,session_id,ordinal),
      FOREIGN KEY(provider,session_id) REFERENCES adit_history_sessions(provider,id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS adit_history_messages_time ON adit_history_messages(occurred_at,provider,model);
    CREATE TABLE IF NOT EXISTS adit_history_message_digests (
      message_id TEXT PRIMARY KEY REFERENCES adit_history_messages(id) ON DELETE CASCADE, digest TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS adit_history_messages_turn ON adit_history_messages(turn_id,ordinal);
    CREATE INDEX IF NOT EXISTS adit_history_message_scope_time ON adit_history_messages(provider,session_id,occurred_at);
    CREATE INDEX IF NOT EXISTS adit_history_assistant_scope_time ON adit_history_messages(provider,session_id,occurred_at,id) WHERE role='assistant';
    CREATE TABLE IF NOT EXISTS adit_history_blocks (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES adit_history_messages(id) ON DELETE CASCADE,
      block_index INTEGER NOT NULL, kind TEXT NOT NULL, text_content TEXT, data_json TEXT,
      UNIQUE(message_id,block_index)
    );
    CREATE TABLE IF NOT EXISTS adit_history_relations (
      provider TEXT NOT NULL, session_id TEXT NOT NULL, parent_id TEXT NOT NULL, kind TEXT NOT NULL,
      PRIMARY KEY(provider,session_id),
      FOREIGN KEY(provider,session_id) REFERENCES adit_history_sessions(provider,id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS adit_history_relations_parent ON adit_history_relations(provider,parent_id,kind);
    CREATE TABLE IF NOT EXISTS adit_history_turns (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, session_id TEXT NOT NULL,
      prompt_message_id TEXT NOT NULL, last_message_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      started_at INTEGER, ended_at INTEGER, work_duration_ms INTEGER, duration_status TEXT NOT NULL,
      FOREIGN KEY(provider,session_id) REFERENCES adit_history_sessions(provider,id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS adit_history_turns_session ON adit_history_turns(provider,session_id,ordinal);
    CREATE TABLE IF NOT EXISTS adit_history_work_intervals (
      id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES adit_history_turns(id) ON DELETE CASCADE,
      start_message_id TEXT NOT NULL, end_message_id TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, counted_duration_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS adit_history_intervals_turn ON adit_history_work_intervals(turn_id);
    CREATE TABLE IF NOT EXISTS adit_history_tool_calls (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES adit_history_messages(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT, call_index INTEGER NOT NULL,
      source_call_id TEXT, tool_name TEXT, command_text TEXT, file_path TEXT, working_directory TEXT,
      occurred_at INTEGER, status TEXT NOT NULL, input_json TEXT
    );
    CREATE INDEX IF NOT EXISTS adit_history_tools_session ON adit_history_tool_calls(provider,session_id,turn_id);
    CREATE INDEX IF NOT EXISTS adit_history_tools_native ON adit_history_tool_calls(provider,session_id,source_call_id);
    CREATE INDEX IF NOT EXISTS adit_history_tools_message ON adit_history_tool_calls(message_id);
    CREATE TABLE IF NOT EXISTS adit_history_tool_results (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES adit_history_messages(id) ON DELETE CASCADE,
      tool_call_id TEXT REFERENCES adit_history_tool_calls(id) ON DELETE SET NULL,
      provider TEXT NOT NULL, session_id TEXT NOT NULL, source_call_id TEXT, event_index INTEGER NOT NULL,
      occurred_at INTEGER, status TEXT NOT NULL, exit_code INTEGER, content_text TEXT, content_json TEXT
    );
    CREATE INDEX IF NOT EXISTS adit_history_results_call ON adit_history_tool_results(tool_call_id,event_index);
    CREATE INDEX IF NOT EXISTS adit_history_results_message ON adit_history_tool_results(message_id);
    CREATE INDEX IF NOT EXISTS adit_history_results_native ON adit_history_tool_results(provider,session_id,source_call_id);
    CREATE TABLE IF NOT EXISTS adit_history_usage_observations (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, session_id TEXT NOT NULL,
      message_id TEXT REFERENCES adit_history_messages(id) ON DELETE CASCADE,
      turn_id TEXT, source_key TEXT NOT NULL, scope TEXT NOT NULL, source_kind TEXT NOT NULL,
      model TEXT, request_id TEXT, response_id TEXT, occurred_at INTEGER, raw_usage_json TEXT NOT NULL,
      FOREIGN KEY(provider,session_id) REFERENCES adit_history_sessions(provider,id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS adit_history_observation_message ON adit_history_usage_observations(message_id);
    CREATE INDEX IF NOT EXISTS adit_history_observation_session ON adit_history_usage_observations(provider,session_id);
    CREATE TABLE IF NOT EXISTS adit_history_usage_entries (
      id TEXT PRIMARY KEY REFERENCES adit_history_usage_observations(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT, turn_id TEXT,
      model TEXT, occurred_at INTEGER, scope TEXT NOT NULL, dedup_key TEXT NOT NULL,
      ledger_role TEXT NOT NULL, exclusion_reason TEXT, input_semantics TEXT NOT NULL,
      input_reported_tokens INTEGER, input_total_tokens INTEGER, uncached_input_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, cache_write_5m_tokens INTEGER, cache_write_1h_tokens INTEGER,
      output_tokens INTEGER, reasoning_tokens INTEGER, total_tokens INTEGER,
      provider_cost_microusd INTEGER, completeness TEXT NOT NULL,
      UNIQUE(provider,session_id,dedup_key)
    );
    CREATE INDEX IF NOT EXISTS adit_history_usage_time ON adit_history_usage_entries(occurred_at,provider,model);
    CREATE INDEX IF NOT EXISTS adit_history_usage_turn ON adit_history_usage_entries(provider,session_id,turn_id);
    CREATE TABLE IF NOT EXISTS adit_history_edit_evidence (
      id TEXT PRIMARY KEY, tool_call_id TEXT NOT NULL REFERENCES adit_history_tool_calls(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT, file_path TEXT,
      occurred_at INTEGER, evidence_kind TEXT NOT NULL, content_text TEXT NOT NULL, content_digest TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS adit_history_edit_digest ON adit_history_edit_evidence(content_digest,occurred_at);
    CREATE INDEX IF NOT EXISTS adit_history_edit_tool ON adit_history_edit_evidence(tool_call_id);
    CREATE TABLE IF NOT EXISTS adit_history_commit_operations (
      id TEXT PRIMARY KEY, tool_call_id TEXT NOT NULL REFERENCES adit_history_tool_calls(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT, occurred_at INTEGER,
      command_text TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS adit_history_commit_op_tool ON adit_history_commit_operations(tool_call_id);
  `);
  createAttributionSchema(db);
  const messageColumns = db.prepare("PRAGMA table_info(adit_history_messages)").all() as { name: string }[];
  if (!messageColumns.some(column => column.name === "raw_content_paths_json")) db.transaction(() => {
    const current = db.prepare("PRAGMA table_info(adit_history_messages)").all() as { name: string }[];
    if (!current.some(column => column.name === "raw_content_paths_json"))
      db.exec("ALTER TABLE adit_history_messages ADD COLUMN raw_content_paths_json TEXT");
  }).immediate();
  const usageColumns = new Set((db.prepare("PRAGMA table_info(adit_history_usage_entries)").all() as {name:string}[]).map(column => column.name));
  db.transaction(() => {
    const names = ["input_cost_microusd", "output_cost_microusd", "cache_read_cost_microusd", "cache_write_cost_microusd", "cost_microusd"];
    for (const name of names)
      if (!usageColumns.has(name)) db.exec(`ALTER TABLE adit_history_usage_entries ADD COLUMN ${name} INTEGER`);
    if (names.some(name => !usageColumns.has(name))) db.exec("UPDATE adit_history_sessions SET transcript_revision=transcript_revision+1");
  })();
  createInspectionSchema(db);
  removeHistorySearchIndex(db);
}
