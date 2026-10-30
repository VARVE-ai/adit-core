import type Database from "better-sqlite3";
import { historyBlockDataSql } from "./block-data.js";
import { createHmac, randomUUID } from "node:crypto";
import type { LocalWorkspace } from "../local-state.js";
import { LocalStateError } from "../local-state.js";
import { insideDirectory } from "./sources.js";
import {
  SECRET_RULES,
  SECRET_RULES_VERSION,
  scanSecretField,
  redactSecrets,
} from "./secret-detector.js";
import {
  createInspectionSchema,
  registerHistoryRedaction,
} from "./inspection-schema.js";
type Row = Record<string, any>;
// Field ownership can change independently of detection/redaction rules. Force
// a rescan without rebuilding an already masked search index.
const INSPECTION_SCAN_VERSION = `${SECRET_RULES_VERSION}:fields-2`;
export type InspectionStatus = "pending" | "handled" | "ignored";
export interface InspectionFinding {
  id: string;
  provider: string;
  sessionId: string;
  title: string;
  rule: string;
  confidence: "definite" | "candidate";
  status: InspectionStatus;
  masked: string;
  location: string;
  occurredAt: number | null;
  turn: number | null;
  line: number;
}
export interface InspectionData {
  rules: typeof SECRET_RULES;
  total: number;
  main: number;
  children: number;
  checked: number;
  maskReady: boolean;
  pendingDefinite: number;
  pendingCandidate: number;
  counts: Record<InspectionStatus, number>;
  items: InspectionFinding[];
  sessions?: InspectionSessionSummary[];
  nextOffset: number | null;
  run: InspectionRun | null;
}
export interface InspectionSessionSummary {
  provider: string;
  sessionId: string;
  title: string;
  occurredAt: number | null;
  count: number;
  rules: string[];
}
export type InspectionView =
  | { kind: "sessions" }
  | { kind: "session"; provider: string; sessionId: string };
export interface InspectionRun {
  id: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
  startedAt: number;
  finishedAt: number | null;
}
export interface InspectionDetail extends InspectionFinding {
  context: string;
  line: number;
  field: string;
  command: string | null;
  description: string | null;
  source: string | null;
  model: string | null;
  effort: string | null;
  input: number | null;
  output: number | null;
  cache: number | null;
  maskReady: boolean;
  envRead: boolean;
}
type Field = {
  text: string;
  key: string;
  location: string;
  message: Row;
  tool: string | null;
};
const decode = (s: string | null) => {
  try {
    return s === null ? null : JSON.parse(s);
  } catch {
    return s;
  }
};
const toolKinds = new Set([
  "tool_use",
  "tool_result",
  "toolCall",
  "toolResult",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
]);
function* strings(
  value: unknown,
  path: string,
): Generator<{ text: string; key: string }> {
  if (typeof value === "string") yield { text: value, key: path };
  else if (Array.isArray(value))
    for (let i = 0; i < value.length; i++)
      yield* strings(value[i], `${path}/${i}`);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      if (["type", "id", "call_id", "tool_use_id"].includes(k)) continue;
      if (typeof v === "string" && /(?:key|token|password|secret)$/i.test(k))
        yield { text: `${k}=${v}`, key: `${path}/${k}` };
      else yield* strings(v, `${path}/${k}`);
    }
}
export class LocalInspection {
  private key: string;
  constructor(readonly db: Database.Database) {
    registerHistoryRedaction(db);
    createInspectionSchema(db);
    this.key = (
      db
        .prepare(
          "SELECT value FROM adit_history_inspection_meta WHERE key='fingerprint-key'",
        )
        .get() as Row
    ).value;
  }
  scope(workspace: LocalWorkspace): Row[] {
    const rows = this.db
      .prepare(
        `SELECT s.provider,s.id,s.parent_id,s.relationship,s.transcript_revision,coalesce(nullif(s.cwd,''),a.workspace,'') AS effective_cwd
      FROM adit_history_sessions s LEFT JOIN adit_history_assignments a ON a.provider=s.provider AND a.session_id=s.id`,
      )
      .all() as Row[];
    const selected = new Set(
      rows
        .filter(
          (s) =>
            s.effective_cwd && insideDirectory(workspace.path, s.effective_cwd),
        )
        .map((s) => JSON.stringify([s.provider, s.id])),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of rows)
        if (
          s.parent_id &&
          selected.has(JSON.stringify([s.provider, s.parent_id])) &&
          !selected.has(JSON.stringify([s.provider, s.id]))
        ) {
          selected.add(JSON.stringify([s.provider, s.id]));
          changed = true;
        }
    }
    return rows.filter((s) => selected.has(JSON.stringify([s.provider, s.id])));
  }
  private scopeJSON(workspace: LocalWorkspace) {
    return JSON.stringify(this.scope(workspace).map((s) => [s.provider, s.id]));
  }
  // An uncorrelated row-value IN builds the scope once. A correlated json_each
  // would parse the whole workspace for every finding in a large archive.
  private scopeSQL = `(f.provider,f.session_id) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))`;
  private currentSQL = `f.active=1 AND f.rules_version='${INSPECTION_SCAN_VERSION}' AND f.transcript_revision=s.transcript_revision`;
  private *fields(provider: string, id: string): Generator<Field> {
    const messages = this.db
      .prepare(
        "SELECT id,source_key,role,turn_id,occurred_at FROM adit_history_messages WHERE provider=? AND session_id=? ORDER BY ordinal",
      )
      .iterate(provider, id) as Iterable<Row>;
    const blocks = this.db.prepare(
      `SELECT b.id,b.message_id,b.block_index,b.kind,b.text_content,
       CASE WHEN coalesce(b.text_content,'')='' OR (m.provider='deepseek-harness' AND b.kind='tool-call')
         THEN ${historyBlockDataSql()} END AS data_json
       FROM adit_history_blocks b JOIN adit_history_messages m ON m.id=b.message_id WHERE b.message_id=? ORDER BY b.block_index`,
    );
    const calls = this.db.prepare(
      "SELECT * FROM adit_history_tool_calls WHERE message_id=? ORDER BY call_index",
    );
    const results = this.db.prepare(
      "SELECT * FROM adit_history_tool_results WHERE message_id=? ORDER BY event_index",
    );
    const nativeType = this.db.prepare(
      "SELECT json_extract(raw_json,'$.payload.type') AS kind FROM adit_history_messages WHERE id=?",
    );
    for (const message of messages) {
      const c = calls.all(message.id) as Row[],
        r = results.all(message.id) as Row[];
      // Codex's native calls also have a plain-text content projection. The
      // canonical input below owns that content; it is not another reply.
      // Use the native record type, not text equality: a real reply can quote
      // exactly the same value and must remain a distinct occurrence.
      const inputProjection =
        c.length > 0 &&
        ["function_call", "custom_tool_call"].includes(
          (nativeType.get(message.id) as Row | undefined)?.kind,
        );
      const harnessCalls = new Set<string>();
      for (const b of blocks.all(message.id) as Row[]) {
        // Keep the original native field identity when an older Harness block
        // gains a normalized tool call, so existing dispositions remain attached.
        const harnessCall = provider === "deepseek-harness" && b.kind === "tool-call"
          ? c.find(call => call.source_call_id === decode(b.data_json)?.id) : undefined;
        if (harnessCall) harnessCalls.add(harnessCall.id);
        if (
          inputProjection ||
          (toolKinds.has(b.kind) && (c.length || r.length)) ||
          (message.role === "tool" && r.length)
        )
          continue;
        const body = b.text_content
          ? [{ text: b.text_content, key: `block/${b.block_index}` }]
          : strings(decode(b.data_json), `block/${b.block_index}`);
        for (const field of body)
          yield {
            ...field,
            message,
            tool: harnessCall?.id ?? null,
            location: harnessCall ? "tool_input" : message.role === "user" ? "prompt" : "response",
          };
      }
      for (const call of c) {
        if (harnessCalls.has(call.id)) continue;
        let value = decode(call.input_json);
        if (typeof value === "string") {
          try {
            value = JSON.parse(value);
          } catch {}
        }
        for (const field of strings(
          value,
          `call/${call.source_call_id || call.call_index}`,
        ))
          yield { ...field, message, tool: call.id, location: "tool_input" };
      }
      for (const result of r) {
        const value = decode(result.content_json) ?? result.content_text;
        for (const field of strings(
          value,
          `result/${provider === "deepseek-harness" ? "" : result.source_call_id || ""}/${result.event_index}`,
        ))
          yield {
            ...field,
            message,
            tool: result.tool_call_id,
            location: "tool_output",
          };
      }
    }
  }
  scanSession(provider: string, id: string, definiteOnly = false): boolean {
    const session = this.db
      .prepare(
        "SELECT transcript_revision FROM adit_history_sessions WHERE provider=? AND id=?",
      )
      .get(provider, id) as Row | undefined;
    if (!session) return false;
    const version = session.transcript_revision,
      now = Date.now(),
      found: Row[] = [];
    for (const field of this.fields(provider, id)) {
      const duplicates = new Map<string, number>();
      const scanned = scanSecretField(field.text, definiteOnly);
      let line = 1,
        newline = field.text.indexOf("\n");
      for (const m of scanned.matches) {
        while (newline >= 0 && newline < m.start) {
          line++;
          newline = field.text.indexOf("\n", newline + 1);
        }
        const fingerprint = createHmac("sha256", this.key)
          .update(field.text.slice(m.start, m.end))
          .digest("hex");
        const key = JSON.stringify([
          provider,
          id,
          field.message.source_key,
          field.key,
          m.rule,
          fingerprint,
        ]);
        const occurrence = duplicates.get(key) || 0;
        duplicates.set(key, occurrence + 1);
        const findingId = createHmac("sha256", this.key)
          .update(key + ":" + occurrence)
          .digest("hex");
        const lineStart = field.text.lastIndexOf("\n", m.start - 1) + 1,
          eol = field.text.indexOf("\n", m.end);
        found.push({
          id: findingId,
          message: field.message,
          field: { tool: field.tool, location: field.location, key: field.key },
          match: m,
          context: scanned
            .window(
              Math.max(lineStart, m.start - 240),
              Math.min(eol < 0 ? field.text.length : eol, m.end + 400),
            )
            .slice(0, 1600),
          line,
        });
      }
    }
    return this.db
      .transaction(() => {
        const current = this.db
          .prepare(
            "SELECT transcript_revision FROM adit_history_sessions WHERE provider=? AND id=?",
          )
          .get(provider, id) as Row | undefined;
        if (current?.transcript_revision !== version) return false;
        this.db
          .prepare(
            "UPDATE adit_history_secret_findings SET active=0 WHERE provider=? AND session_id=?",
          )
          .run(provider, id);
        const insert = this.db
          .prepare(`INSERT INTO adit_history_secret_findings VALUES (${Array(22).fill("?").join(",")}) ON CONFLICT(id) DO UPDATE SET
        message_id=excluded.message_id,turn_id=excluded.turn_id,tool_call_id=excluded.tool_call_id,location_kind=excluded.location_kind,match_start=excluded.match_start,match_end=excluded.match_end,
        line_number=excluded.line_number,masked_context=excluded.masked_context,masked_value=excluded.masked_value,transcript_revision=excluded.transcript_revision,
        rules_version=excluded.rules_version,occurred_at=excluded.occurred_at,last_seen_at=excluded.last_seen_at,active=1`);
        for (const f of found)
          insert.run(
            f.id,
            provider,
            id,
            f.message.id,
            f.message.turn_id,
            f.field.tool,
            f.message.source_key,
            f.field.location,
            f.field.key,
            f.match.start,
            f.match.end,
            f.line,
            f.match.rule,
            f.match.confidence,
            f.match.masked,
            f.context,
            version,
            INSPECTION_SCAN_VERSION,
            f.message.occurred_at,
            now,
            now,
            1,
          );
        this.db
          .prepare(
            `INSERT INTO adit_history_secret_scan_states VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(provider,session_id) DO UPDATE SET
        transcript_revision=excluded.transcript_revision,rules_version=excluded.rules_version,mode=excluded.mode,checked_at=excluded.checked_at,
        definite_count=excluded.definite_count,candidate_count=excluded.candidate_count`,
          )
          .run(
            provider,
            id,
            version,
            INSPECTION_SCAN_VERSION,
            definiteOnly ? "definite" : "full",
            now,
            found.filter((f) => f.match.confidence === "definite").length,
            found.filter((f) => f.match.confidence === "candidate").length,
          );
        return true;
      })
      .immediate();
  }
  maskReady(): boolean {
    // Display and search redact stored originals at read time. There is no
    // persisted search body or index to sanitize before browsing.
    return true;
  }
  start(workspace: LocalWorkspace, trigger = "manual"): string {
    const active = this.db
      .prepare(
        "SELECT id FROM adit_history_secret_scan_runs WHERE workspace_id=? AND status IN ('queued','running','indexing') ORDER BY started_at DESC LIMIT 1",
      )
      .get(workspace.id) as Row | undefined;
    if (active) return active.id;
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO adit_history_secret_scan_runs(id,workspace_id,trigger_kind,rules_version,status,started_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        workspace.id,
        trigger,
        INSPECTION_SCAN_VERSION,
        "queued",
        Date.now(),
      );
    return id;
  }
  async run(workspace: LocalWorkspace, runId: string, force = false) {
    const cancelled = () =>
      !!(
        this.db
          .prepare(
            "SELECT cancel_requested FROM adit_history_secret_scan_runs WHERE id=?",
          )
          .get(runId) as Row
      )?.cancel_requested;
    try {
      this.db
        .prepare(
          "UPDATE adit_history_secret_scan_runs SET status='running' WHERE id=?",
        )
        .run(runId);
      const sessions = this.scope(workspace).filter((s) => {
        const state = this.db
          .prepare(
            "SELECT * FROM adit_history_secret_scan_states WHERE provider=? AND session_id=?",
          )
          .get(s.provider, s.id) as Row | undefined;
        return (
          force ||
          state?.transcript_revision !== s.transcript_revision ||
          state?.rules_version !== INSPECTION_SCAN_VERSION ||
          state?.mode !== "full"
        );
      });
      this.db
        .prepare(
          "UPDATE adit_history_secret_scan_runs SET status='running',total=?,completed=0 WHERE id=?",
        )
        .run(sessions.length, runId);
      for (const s of sessions) {
        if (cancelled()) break;
        let success = false;
        try {
          success = this.scanSession(s.provider, s.id);
        } catch {
          /* No source content in errors or logs. */
        }
        this.db
          .prepare(
            `UPDATE adit_history_secret_scan_runs SET ${success ? "completed=completed+1" : "failed=failed+1"} WHERE id=?`,
          )
          .run(runId);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      this.db
        .prepare(
          "UPDATE adit_history_secret_scan_runs SET status=CASE WHEN cancel_requested=1 THEN 'cancelled' WHEN failed>0 THEN 'partial' ELSE 'done' END,finished_at=? WHERE id=?",
        )
        .run(Date.now(), runId);
    } catch {
      this.db
        .prepare(
          "UPDATE adit_history_secret_scan_runs SET status='failed',finished_at=? WHERE id=?",
        )
        .run(Date.now(), runId);
    }
  }
  cancel(workspace: LocalWorkspace) {
    this.db
      .prepare(
        "UPDATE adit_history_secret_scan_runs SET cancel_requested=1 WHERE workspace_id=? AND status IN ('queued','running','indexing')",
      )
      .run(workspace.id);
  }
  private baseSQL = `FROM adit_history_secret_findings f JOIN adit_history_sessions s ON s.provider=f.provider AND s.id=f.session_id
    LEFT JOIN adit_history_secret_dispositions d ON d.finding_id=f.id LEFT JOIN adit_history_turns t ON t.id=f.turn_id`;
  pendingCount(workspace: LocalWorkspace): number {
    return (
      this.db
        .prepare(
          `SELECT count(*) AS n ${this.baseSQL}
      WHERE f.confidence='definite' AND ${this.currentSQL} AND ${this.scopeSQL}
      AND coalesce(d.status,'pending')='pending'`,
        )
        .get(this.scopeJSON(workspace)) as Row
    ).n;
  }
  private item(r: Row): InspectionFinding {
    return {
      id: r.id,
      provider: r.provider,
      sessionId: r.session_id,
      title: redactSecrets(r.title || r.first_prompt || r.session_id),
      rule: r.rule,
      confidence: r.confidence,
      status: r.disposition || "pending",
      masked: r.masked_value,
      location: r.location_kind,
      occurredAt: r.occurred_at,
      turn: r.turn_ordinal ?? null,
      line: r.line_number,
    };
  }
  read(
    workspace: LocalWorkspace,
    status: InspectionStatus = "pending",
    offset = 0,
    rule?: string,
    view?: InspectionView,
  ): InspectionData {
    if (rule && !SECRET_RULES.some((r) => r.id === rule))
      throw new LocalStateError("Invalid inspection rule");
    const scope = this.scope(workspace),
      scopeJSON = JSON.stringify(scope.map((s) => [s.provider, s.id]));
    const counts: Record<InspectionStatus, number> = {
      pending: 0,
      handled: 0,
      ignored: 0,
    };
    let pendingDefinite = 0,
      pendingCandidate = 0;
    const totals = this.db
      .prepare(
        `SELECT f.confidence,f.rule,coalesce(d.status,'pending') AS disposition,count(*) AS n
      ${this.baseSQL} WHERE ${this.currentSQL} AND ${this.scopeSQL}
      GROUP BY f.confidence,f.rule,coalesce(d.status,'pending')`,
      )
      .all(scopeJSON) as Row[];
    for (const row of totals) {
      if (rule ? row.rule === rule : row.confidence === "definite")
        counts[row.disposition as InspectionStatus] += row.n;
      if (row.disposition === "pending") {
        if (row.confidence === "definite") pendingDefinite += row.n;
        else pendingCandidate += row.n;
      }
    }
    const sessionFilter = view?.kind === "session";
    const grouped = view?.kind === "sessions";
    const rows = this.db
      .prepare(
        `SELECT ${
          grouped
            ? `f.provider,f.session_id,s.title,s.first_prompt,
      max(f.occurred_at) AS occurred_at,count(*) AS finding_count,group_concat(DISTINCT f.rule) AS finding_rules`
            : `f.id,f.provider,f.session_id,f.rule,f.confidence,f.masked_value,
      f.location_kind,f.occurred_at,f.line_number,s.title,s.first_prompt,t.ordinal AS turn_ordinal,
      coalesce(d.status,'pending') AS disposition`
        } ${this.baseSQL}
      WHERE ${this.currentSQL} AND ${this.scopeSQL} AND ${rule ? "f.rule=?" : "f.confidence='definite'"}
      AND coalesce(d.status,'pending')=? ${sessionFilter ? "AND f.provider=? AND f.session_id=?" : ""}
      ${grouped ? "GROUP BY f.provider,f.session_id ORDER BY max(f.occurred_at) DESC,f.provider,f.session_id" : "ORDER BY f.occurred_at DESC,f.id"} LIMIT 51 OFFSET ?`,
      )
      .all(
        scopeJSON,
        ...(rule ? [rule] : []),
        status,
        ...(sessionFilter ? [view.provider, view.sessionId] : []),
        offset,
      ) as Row[];
    const states = this.db
      .prepare("SELECT * FROM adit_history_secret_scan_states")
      .all() as Row[];
    const stateMap = new Map(
      states.map((s) => [JSON.stringify([s.provider, s.session_id]), s]),
    );
    const checked = scope.filter((s) => {
      const st = stateMap.get(JSON.stringify([s.provider, s.id]));
      return (
        st?.transcript_revision === s.transcript_revision &&
        st?.rules_version === INSPECTION_SCAN_VERSION &&
        st?.mode === "full"
      );
    }).length;
    const main = scope.filter(
      (s) => !s.parent_id || s.relationship === "fork",
    ).length;
    const run = this.db
      .prepare(
        "SELECT id,status,total,completed,failed,started_at AS startedAt,finished_at AS finishedAt FROM adit_history_secret_scan_runs WHERE workspace_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1",
      )
      .get(workspace.id) as InspectionRun | undefined;
    return {
      rules: SECRET_RULES,
      total: scope.length,
      main,
      children: scope.length - main,
      checked,
      maskReady: this.maskReady(),
      pendingDefinite,
      pendingCandidate,
      counts,
      items: grouped ? [] : rows.slice(0, 50).map((r) => this.item(r)),
      ...(grouped
        ? {
            sessions: rows.slice(0, 50).map((r) => ({
              provider: r.provider,
              sessionId: r.session_id,
              title: redactSecrets(r.title || r.first_prompt || r.session_id),
              occurredAt: r.occurred_at,
              count: r.finding_count,
              rules: String(r.finding_rules).split(","),
            })),
          }
        : {}),
      nextOffset: rows.length > 50 ? offset + 50 : null,
      run: run || null,
    };
  }
  private finding(workspace: LocalWorkspace, id: string): Row {
    const row = this.db
      .prepare(
        `SELECT f.*,s.title,s.first_prompt,t.ordinal AS turn_ordinal,coalesce(d.status,'pending') AS disposition ${this.baseSQL} WHERE f.id=? AND ${this.currentSQL} AND ${this.scopeSQL}`,
      )
      .get(id, this.scopeJSON(workspace)) as Row | undefined;
    if (!row)
      throw new LocalStateError(
        "Inspection finding is unavailable; refresh the results",
        404,
      );
    return row;
  }
  detail(workspace: LocalWorkspace, id: string): InspectionDetail {
    const row = this.finding(workspace, id);
    const call = row.tool_call_id
      ? (this.db
          .prepare(
            "SELECT command_text,input_json FROM adit_history_tool_calls WHERE id=?",
          )
          .get(row.tool_call_id) as Row | undefined)
      : undefined;
    const meta = this.db
      .prepare(
        "SELECT model,effort FROM adit_history_messages WHERE turn_id=? AND (model IS NOT NULL OR effort IS NOT NULL) ORDER BY ordinal DESC LIMIT 1",
      )
      .get(row.turn_id) as Row | undefined;
    const usage = this.db
      .prepare(
        `SELECT CASE WHEN count(uncached_input_tokens)=count(*) THEN sum(uncached_input_tokens) END AS input,
      CASE WHEN count(output_tokens)=count(*) THEN sum(output_tokens) END AS output,CASE WHEN count(cache_read_tokens)=count(*) THEN sum(cache_read_tokens) END AS cache
      FROM adit_history_usage_entries WHERE turn_id=? AND ledger_role='canonical'`,
      )
      .get(row.turn_id) as Row;
    const source = this.db
      .prepare(
        "SELECT path FROM adit_history_sources WHERE provider=? AND session_id=? ORDER BY path LIMIT 1",
      )
      .get(row.provider, row.session_id) as Row | undefined;
    let input = decode(call?.input_json ?? null);
    if (typeof input === "string") input = decode(input);
    return {
      ...this.item(row),
      context: row.masked_context,
      line: row.line_number,
      field: row.field_path,
      command: call?.command_text
        ? redactSecrets(call.command_text).slice(0, 16000)
        : null,
      description:
        typeof input?.description === "string"
          ? redactSecrets(input.description)
          : null,
      source: source?.path ? redactSecrets(source.path) : null,
      model: meta?.model || null,
      effort: meta?.effort || null,
      input: usage.input,
      output: usage.output,
      cache: usage.cache,
      maskReady: this.maskReady(),
      envRead:
        row.location_kind === "tool_output" &&
        /(?:cat|sed|head|tail|Get-Content|type)\b[^\n]*[\s/'"]\.env(?:[\s'";&]|$)/i.test(
          call?.command_text || "",
        ),
    };
  }
  setStatus(workspace: LocalWorkspace, id: string, status: InspectionStatus) {
    if (!["pending", "handled", "ignored"].includes(status))
      throw new LocalStateError("Invalid inspection status");
    this.db
      .transaction(() => {
        this.finding(workspace, id);
        this.db
          .prepare(
            "INSERT INTO adit_history_secret_dispositions VALUES(?,?,?) ON CONFLICT(finding_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at",
          )
          .run(id, status, Date.now());
      })
      .immediate();
  }
  setSessionStatus(
    workspace: LocalWorkspace,
    provider: string,
    sessionId: string,
    from: InspectionStatus,
    status: InspectionStatus,
    rule?: string,
  ): number {
    if (
      !provider ||
      !sessionId ||
      !["pending", "handled", "ignored"].includes(from) ||
      !["pending", "handled", "ignored"].includes(status)
    )
      throw new LocalStateError("Invalid inspection status");
    if (rule && !SECRET_RULES.some((r) => r.id === rule))
      throw new LocalStateError("Invalid inspection rule");
    // Keep each occurrence independent in storage. Apply the current session's
    // filtered results in one transaction, including cards not yet loaded.
    return this.db
      .transaction(
        () =>
          this.db
            .prepare(
              `
      INSERT INTO adit_history_secret_dispositions(finding_id,status,updated_at)
      SELECT f.id,?,? ${this.baseSQL}
      WHERE ${this.currentSQL} AND ${this.scopeSQL}
      AND f.provider=? AND f.session_id=? AND coalesce(d.status,'pending')=?
      AND ${rule ? "f.rule=?" : "f.confidence='definite'"}
      ON CONFLICT(finding_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at
    `,
            )
            .run(
              status,
              Date.now(),
              this.scopeJSON(workspace),
              provider,
              sessionId,
              from,
              ...(rule ? [rule] : []),
            ).changes,
      )
      .immediate();
  }
  sourcePath(workspace: LocalWorkspace, id: string): string | null {
    const row = this.finding(workspace, id);
    return (
      (
        this.db
          .prepare(
            "SELECT path FROM adit_history_sources WHERE provider=? AND session_id=? AND path NOT LIKE 'import:%' ORDER BY path LIMIT 1",
          )
          .get(row.provider, row.session_id) as Row | undefined
      )?.path || null
    );
  }
}
