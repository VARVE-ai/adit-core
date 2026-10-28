import type { LocalStore } from "@varveai/adit-core";
import { handleSQL, pollSQL, submissionSQL, submissionInputSQL, submissionScope, writeSQL } from "./attribution-plan.js";
import { streamedSubmissionCandidates } from "./submission-evidence.js";

type Row = Record<string, any>;
const inScope = `(t.provider,t.session_id) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))`;

export function callIdentities(store: LocalStore, scope: string) {
  return store.db.prepare(
    `SELECT t.provider,t.session_id,t.source_call_id FROM adit_history_tool_calls t WHERE ${inScope}`,
  ).iterate(scope) as Iterable<Row>;
}

export function writeCalls(store: LocalStore, scope: string, latest: number) {
  return store.db.prepare(
    `SELECT t.id,t.provider,t.session_id,t.tool_name,t.file_path,t.working_directory,t.occurred_at
      FROM adit_history_tool_calls t WHERE ${inScope} AND ${writeSQL}
      AND (t.occurred_at IS NULL OR t.occurred_at<=?) AND NOT EXISTS (
        SELECT 1 FROM adit_history_tool_results r WHERE r.tool_call_id=t.id
          AND (r.status IN ('error','failed') OR (r.exit_code IS NOT NULL AND r.exit_code<>0)))`,
  ).iterate(scope, latest) as Iterable<Row>;
}

export function readSubmissionCandidates(store: LocalStore, scope: string) {
  const selected = submissionScope(store, scope);
  if (selected === "[]") return [];
  const calls = store.db.prepare(
    `SELECT t.id,t.provider,t.session_id,t.turn_id,t.working_directory,t.occurred_at,
      (${submissionSQL} OR ${pollSQL}) AS relevant
      FROM adit_history_tool_calls t JOIN adit_history_messages m ON m.id=t.message_id
      WHERE ${inScope} AND ${submissionInputSQL}
      ORDER BY coalesce(t.occurred_at,9e99),m.ordinal,t.call_index,t.id`,
  );
  const payload = store.db.prepare("SELECT * FROM adit_history_tool_calls WHERE id=?");
  const results = store.db.prepare(
    "SELECT r.tool_call_id,r.content_text,r.occurred_at,r.exit_code,r.status FROM adit_history_tool_results r WHERE r.tool_call_id=? ORDER BY r.rowid",
  );
  const handles = store.db.prepare(
    `SELECT r.tool_call_id,r.content_text,r.occurred_at,r.exit_code,r.status FROM adit_history_tool_results r
      WHERE r.tool_call_id=? AND ${handleSQL} ORDER BY r.rowid`,
  );
  function* records() {
    for (const metadata of calls.iterate(selected) as Iterable<Row>) {
      const call = metadata.relevant ? payload.get(metadata.id) as Row
        : { ...metadata, tool_name: "exec_command", command_text: "", input_json: null };
      const outputs = (metadata.relevant ? results : handles).all(metadata.id) as Row[];
      yield { call, outputs };
    }
  }
  return streamedSubmissionCandidates(records());
}
