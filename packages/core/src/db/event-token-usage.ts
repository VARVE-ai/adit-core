import type Database from "better-sqlite3";
import type { TokenUsageRecord } from "../usage.js";

export interface EventTokenUsage {
  revision: number;
  turnId: string;
  requests: number;
  observations: number;
  incomplete: number;
  inputTokens: number | null;
  uncachedInputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  records: TokenUsageRecord[];
}

export interface TokenCaptureState {
  cursors: Record<string, unknown>;
  pending: TokenUsageRecord[];
}

export function readTokenCaptureState(db: Database.Database, sessionId: string): TokenCaptureState {
  const row = db.prepare("SELECT token_capture_json FROM sessions WHERE id = ?").get(sessionId) as { token_capture_json: string | null } | undefined;
  return row?.token_capture_json ? JSON.parse(row.token_capture_json) : { cursors: {}, pending: [] };
}

export function readSessionUsageRecords(db: Database.Database, sessionId: string): TokenUsageRecord[] {
  const rows = db.prepare("SELECT token_usage_json FROM events WHERE session_id = ? AND token_usage_json IS NOT NULL AND deleted_at IS NULL ORDER BY sequence, id")
    .all(sessionId) as { token_usage_json: string }[];
  return [...rows.flatMap(row => JSON.parse(row.token_usage_json) as TokenUsageRecord[]), ...readTokenCaptureState(db, sessionId).pending]
    .map(record => ({ ...record, sessionId }));
}

export function summarizeEventUsage(records: TokenUsageRecord[]) {
  const requests = records.filter(record => record.granularity === "request");
  const sum = (field: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens" | "totalTokens") => {
    const known = requests.flatMap(record => record[field] === null ? [] : [record[field]]);
    return known.length ? known.reduce((total, value) => total + value, 0) : null;
  };
  const uncached = requests.map(record => record.provider === "claude" ? record.raw.input_tokens ?? null
    : record.inputTokens !== null && record.cacheReadTokens !== null ? record.inputTokens - record.cacheReadTokens : null);
  return {
    requests: requests.length, observations: records.filter(record => record.granularity === "observation").length,
    incomplete: records.filter(record => record.granularity !== "observation" && !record.complete).length,
    inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), totalTokens: sum("totalTokens"),
    cacheReadTokens: sum("cacheReadTokens"), cacheWriteTokens: sum("cacheWriteTokens"), reasoningTokens: sum("reasoningTokens"),
    uncachedInputTokens: uncached.length && uncached.every(value => value !== null && value >= 0)
      ? uncached.reduce<number>((total, value) => total + value!, 0) : null,
  };
}

export function storeSessionUsage(db: Database.Database, sessionId: string, records: TokenUsageRecord[], state: TokenCaptureState): void {
  const events = db.prepare(`SELECT id, event_type, parent_event_id, response_text, token_usage_json FROM events
    WHERE session_id = ? AND deleted_at IS NULL ORDER BY sequence, id`).all(sessionId) as {
      id: string; event_type: string; parent_event_id: string | null; response_text: string | null; token_usage_json: string | null;
    }[];
  const prompts = new Set(events.filter(event => ["prompt_submit", "prompt"].includes(event.event_type)).map(event => event.id));
  const replies = new Map<string, string>();
  let current: string | null = null;
  for (const event of events) {
    if (prompts.has(event.id)) current = event.id;
    else if (["assistant_response", "response"].includes(event.event_type) && event.response_text) {
      const turn = event.parent_event_id ?? current;
      if (turn && prompts.has(turn)) replies.set(turn, event.id);
    }
  }
  const grouped = new Map<string, TokenUsageRecord[]>();
  state.pending = [];
  for (const record of records) {
    if (!record.turnId || !replies.has(record.turnId)) { state.pending.push(record); continue; }
    const turn = grouped.get(record.turnId) ?? [];
    turn.push(record);
    grouped.set(record.turnId, turn);
  }
  for (const [turnId, entries] of grouped) {
    const ownerId = replies.get(turnId)!;
    const serialized = JSON.stringify(entries);
    const owner = events.find(event => event.id === ownerId)!;
    if (owner.token_usage_json === serialized) continue;
    const summary = summarizeEventUsage(entries);
    db.prepare(`UPDATE events SET token_usage_turn_id = ?, token_usage_revision = token_usage_revision + 1,
      token_usage_json = ?, token_requests = ?, token_observations = ?, token_incomplete = ?, token_input = ?,
      token_uncached_input = ?, token_output = ?, token_cache_read = ?, token_cache_write = ?, token_reasoning = ?, token_total = ? WHERE id = ?`)
      .run(turnId, serialized, summary.requests, summary.observations, summary.incomplete, summary.inputTokens,
        summary.uncachedInputTokens, summary.outputTokens, summary.cacheReadTokens, summary.cacheWriteTokens, summary.reasoningTokens, summary.totalTokens, ownerId);
    db.prepare(`UPDATE events SET token_usage_turn_id = NULL, token_usage_json = NULL, token_usage_ack_json = NULL,
      token_requests = NULL, token_observations = NULL, token_incomplete = NULL, token_input = NULL, token_uncached_input = NULL,
      token_output = NULL, token_cache_read = NULL, token_cache_write = NULL, token_reasoning = NULL, token_total = NULL
      WHERE session_id = ? AND token_usage_turn_id = ? AND id <> ?`).run(sessionId, turnId, ownerId);
  }
  db.prepare("UPDATE sessions SET token_capture_json = ? WHERE id = ?").run(JSON.stringify(state), sessionId);
}

export function attachPendingTokenUsage(db: Database.Database, sessionId: string): void {
  db.transaction(() => storeSessionUsage(db, sessionId, readSessionUsageRecords(db, sessionId), readTokenCaptureState(db, sessionId))).immediate();
}

export function eventUsageSummaryFromRow(row: Record<string, unknown>): Omit<EventTokenUsage, "records"> | undefined {
  if (row.deleted_at || !row.token_usage_turn_id || row.token_requests == null) return undefined;
  return {
    revision: row.token_usage_revision as number, turnId: row.token_usage_turn_id as string,
    requests: row.token_requests as number, observations: row.token_observations as number, incomplete: row.token_incomplete as number,
    inputTokens: row.token_input as number | null, uncachedInputTokens: row.token_uncached_input as number | null,
    outputTokens: row.token_output as number | null, cacheReadTokens: row.token_cache_read as number | null,
    cacheWriteTokens: row.token_cache_write as number | null, reasoningTokens: row.token_reasoning as number | null,
    totalTokens: row.token_total as number | null,
  };
}

export function eventUsageFromRow(row: Record<string, unknown>): EventTokenUsage | undefined {
  const summary = eventUsageSummaryFromRow(row);
  if (!summary || !row.token_usage_json) return undefined;
  return { ...summary, records: (JSON.parse(row.token_usage_json as string) as TokenUsageRecord[])
    .map(record => ({ ...record, sessionId: row.session_id as string })) };
}
