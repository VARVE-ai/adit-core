import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { redactSecrets } from "./secret-detector.js";
export function registerHistoryRedaction(db: Database.Database) {
  db.function(
    "adit_history_redact",
    { deterministic: true },
    (text: unknown) => (typeof text === "string" ? redactSecrets(text) : null),
  );
}
export function createInspectionSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS adit_history_inspection_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS adit_history_secret_scan_runs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, trigger_kind TEXT NOT NULL, rules_version TEXT NOT NULL,
      status TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS adit_secret_runs_workspace ON adit_history_secret_scan_runs(workspace_id,started_at DESC);
    CREATE TABLE IF NOT EXISTS adit_history_secret_scan_states (
      provider TEXT NOT NULL,session_id TEXT NOT NULL,transcript_revision INTEGER NOT NULL,
      rules_version TEXT NOT NULL,mode TEXT NOT NULL,checked_at INTEGER NOT NULL,
      definite_count INTEGER NOT NULL,candidate_count INTEGER NOT NULL,
      PRIMARY KEY(provider,session_id),
      FOREIGN KEY(provider,session_id) REFERENCES adit_history_sessions(provider,id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS adit_history_secret_findings (
      id TEXT PRIMARY KEY,provider TEXT NOT NULL,session_id TEXT NOT NULL,message_id TEXT,
      turn_id TEXT,tool_call_id TEXT,source_key TEXT NOT NULL,location_kind TEXT NOT NULL,field_path TEXT NOT NULL,
      match_start INTEGER NOT NULL,match_end INTEGER NOT NULL,line_number INTEGER NOT NULL,
      rule TEXT NOT NULL,confidence TEXT NOT NULL,masked_value TEXT NOT NULL,masked_context TEXT NOT NULL,
      transcript_revision INTEGER NOT NULL,rules_version TEXT NOT NULL,occurred_at INTEGER,
      first_seen_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY(provider,session_id) REFERENCES adit_history_sessions(provider,id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS adit_secret_findings_session ON adit_history_secret_findings(provider,session_id,active);
    CREATE INDEX IF NOT EXISTS adit_secret_findings_filter ON adit_history_secret_findings(confidence,rule,occurred_at DESC,id);
    CREATE TABLE IF NOT EXISTS adit_history_secret_dispositions (
      finding_id TEXT PRIMARY KEY,status TEXT NOT NULL CHECK(status IN ('pending','handled','ignored')),updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS adit_secret_disposition_status ON adit_history_secret_dispositions(status,finding_id);
  `);
  db.prepare(
    "INSERT OR IGNORE INTO adit_history_inspection_meta VALUES ('fingerprint-key',?)",
  ).run(randomBytes(32).toString("hex"));
}
