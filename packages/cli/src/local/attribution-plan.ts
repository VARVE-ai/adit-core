import { createHash } from "node:crypto";
import {
  analyticsSessions,
  createAttributionSchema,
  NON_MERGE_COMMIT_SQL,
  type LocalStore,
  type LocalWorkspace,
} from "@varveai/adit-core";

type Row = Record<string, any>;
export const commandSQL = `coalesce(nullif(t.command_text,''),CASE WHEN json_valid(t.input_json) THEN
  CASE WHEN json_type(t.input_json)='text' THEN json_extract(t.input_json,'$')
  ELSE coalesce(json_extract(t.input_json,'$.code'),json_extract(t.input_json,'$.script'),
    json_extract(t.input_json,'$.command'),json_extract(t.input_json,'$.cmd')) END END,'')`;
export const submissionSQL = `(instr(lower(${commandSQL}),'git')>0 AND instr(lower(${commandSQL}),'commit')>0)`;
export const pollSQL = `(lower(coalesce(t.tool_name,'')) IN ('wait','write_stdin','functions.wait','functions.write_stdin','tools.wait','tools.write_stdin')
  OR instr(${commandSQL},'tools.write_stdin')>0 OR instr(${commandSQL},'tools.wait')>0)`;
export const handleSQL = `(instr(coalesce(r.content_text,''),'session_id')>0 OR instr(coalesce(r.content_text,''),'cell_id')>0
  OR instr(coalesce(r.content_text,''),'Process running with session ID')>0 OR instr(coalesce(r.content_text,''),'Script running with cell ID')>0)`;
export const submissionInputSQL = `((${submissionSQL} OR ${pollSQL}) OR (${commandSQL}<>'' AND EXISTS (
  SELECT 1 FROM adit_history_tool_results r WHERE r.tool_call_id=t.id AND ${handleSQL})))`;
export const writeSQL = `(lower(coalesce(t.tool_name,'')) LIKE '%edit%' OR lower(coalesce(t.tool_name,'')) LIKE '%write%'
  OR lower(coalesce(t.tool_name,'')) LIKE '%patch%' OR ${[
    "writefile", "appendfile", "write_text", "write_bytes", "writeall", "appendalltext",
    "apply_patch", "set-content", "add-content", "out-file", "open(", "cat", "printf", "echo",
  ].map(token => `instr(lower(${commandSQL}),'${token}')>0`).join(" OR ")})`;

export function collectedCommits(store: LocalStore, workspace: LocalWorkspace): Row[] {
  const select = store.db.prepare(
    `SELECT c.repository,c.sha,c.committed_at,c.authored_at,c.subject FROM adit_local_commits c WHERE c.repository=? AND ${NON_MERGE_COMMIT_SQL} ORDER BY c.committed_at,c.sha`,
  );
  return workspace.repositories.flatMap(repository => select.all(repository) as Row[]);
}

export function savedRun(store: LocalStore, workspaceId: string): Row | undefined {
  return store.db.prepare(
    "SELECT * FROM adit_attribution_runs WHERE workspace_id=? AND status='done' ORDER BY started_at DESC LIMIT 1",
  ).get(workspaceId) as Row | undefined;
}

export function submissionScope(store: LocalStore, scope: string): string {
  return JSON.stringify(store.db.prepare(
    `SELECT DISTINCT t.provider,t.session_id FROM adit_history_tool_calls t
      WHERE (t.provider,t.session_id) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))
      AND ${submissionSQL}`,
  ).all(scope).map(row => {
    const call = row as Row;
    return [call.provider, call.session_id];
  }));
}

export function submissionRevision(store: LocalStore, workspace: LocalWorkspace) {
  const sessions = analyticsSessions(store.db, workspace).filter(session => workspace.providers.includes(session.provider));
  const scope = submissionScope(store, JSON.stringify(sessions.map(session => [session.provider, session.id])));
  if (scope === "[]") return null;
  const selected = new Set<string>((JSON.parse(scope) as string[][]).map(parts => JSON.stringify(parts)));
  const relevant = sessions.filter(session => selected.has(JSON.stringify([session.provider, session.id])));
  const revisions = new Map(relevant.map(session => [JSON.stringify([session.provider, session.id]), session.transcript_revision]));
  const hash = createHash("sha256");
  hash.update(JSON.stringify([1, workspace.path, workspace.providers, workspace.repositories,
    relevant.map(session => [session.provider, session.id, session.parent_id, session.relationship, session.cwd])]));
  const calls = store.db.prepare(
    `SELECT t.id,t.provider,t.session_id,t.source_call_id,t.occurred_at,d.digest
      FROM adit_history_tool_calls t LEFT JOIN adit_history_message_digests d ON d.message_id=t.message_id
      WHERE (t.provider,t.session_id) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))
      AND ${submissionInputSQL} ORDER BY t.id`,
  );
  const results = store.db.prepare(
    `SELECT r.id,r.tool_call_id,r.occurred_at,r.status,r.exit_code,d.digest
      FROM adit_history_tool_results r LEFT JOIN adit_history_message_digests d ON d.message_id=r.message_id
      WHERE r.tool_call_id=? ORDER BY r.id`,
  );
  for (const call of calls.iterate(scope) as Iterable<Row>) {
    const revision = revisions.get(JSON.stringify([call.provider, call.session_id]));
    hash.update(JSON.stringify([call, call.digest == null ? revision : null]));
    for (const result of results.iterate(call.id) as Iterable<Row>)
      hash.update(JSON.stringify([result, result.digest == null ? revision : null]));
  }
  return hash.digest("hex");
}

export function submissionCheckpoint(workspace: LocalWorkspace) {
  return `attribution-submissions:${workspace.id}`;
}

function missingSubmissions(store: LocalStore, workspace: LocalWorkspace, runId: string) {
  return JSON.stringify(store.db.prepare(`SELECT saved.repository,saved.sha FROM adit_attribution_commits saved
    JOIN adit_local_commits c ON c.repository=saved.repository AND c.sha=saved.sha
    WHERE saved.run_id=? AND saved.submit_session_id IS NULL AND ${NON_MERGE_COMMIT_SQL}
      AND c.repository IN (SELECT value FROM json_each(?)) ORDER BY saved.repository,saved.sha`)
    .all(runId, JSON.stringify(workspace.repositories)));
}

type SubmissionCheckpoint = { runId: string; revision: string | null; missing: string };

export function attributionNeeded(store: LocalStore, workspace: LocalWorkspace): boolean {
  createAttributionSchema(store.db);
  const previous = savedRun(store, workspace.id);
  const commits = collectedCommits(store, workspace);
  if (!commits.length) return false;
  if (!previous) return true;
  const saved = store.db.prepare(
    "SELECT submit_session_id FROM adit_attribution_commits WHERE run_id=? AND repository=? AND sha=?",
  );
  let missingSubmission = false;
  for (const commit of commits) {
    const result = saved.get(previous.id, commit.repository, commit.sha) as Row | undefined;
    if (!result) return true;
    missingSubmission ||= result.submit_session_id === null;
  }
  if (!missingSubmission) return false;
  const revision = submissionRevision(store, workspace);
  if (revision === null) return false;
  const checkpoint = store.get<SubmissionCheckpoint | null>(submissionCheckpoint(workspace), null);
  return !checkpoint || checkpoint.runId !== previous.id || checkpoint.revision !== revision
    || checkpoint.missing !== missingSubmissions(store, workspace, previous.id);
}

export function rememberSubmissionRevision(store: LocalStore, workspace: LocalWorkspace, revision: string | null) {
  const previous = savedRun(store, workspace.id);
  if (!previous) return;
  const checkpoint = submissionCheckpoint(workspace);
  const state: SubmissionCheckpoint = { runId: previous.id, revision, missing: missingSubmissions(store, workspace, previous.id) };
  if (JSON.stringify(store.get(checkpoint, null)) !== JSON.stringify(state)) store.set(checkpoint, state);
}
