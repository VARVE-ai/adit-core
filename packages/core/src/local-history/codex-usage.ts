import { createHash } from "node:crypto";
import { record, string, type HistoryMessage, type HistoryUsageRecord } from "./types.js";

export interface CodexUsageState {
  targetKey?: string;
  turnId?: string;
  total?: string;
  legacy?: string;
  nativeMirror?: string;
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");

/** Request identities own usage; a message only anchors it to an existing turn.
 * Keep native message keys, content and counts unchanged, including during resume. */
export class CodexUsage {
  readonly state: CodexUsageState;
  private entries = new Map<string, { message: number; index: number }>();
  constructor(private messages: HistoryMessage[], state: CodexUsageState = {}, private archived = new Set<HistoryMessage>()) {
    this.state = { ...state };
    messages.forEach((m, message) => m.usageRecords?.forEach((u, index) => this.entries.set(u.key, { message, index })));
  }
  target(message: HistoryMessage) { this.state.targetKey = message.key; }
  collect(row: Record<string, unknown>, model: string): boolean {
    const p = record(row.payload), native = row.type === "token_usage_record";
    if (!native && !(row.type === "event_msg" && p.type === "token_count")) return false;
    const info = record(p.info), usage = record(native ? p.usage : info.last_token_usage);
    if (!Object.keys(usage).length) return true;
    const total = record(native ? p.thread_token_usage : info.total_token_usage);
    const totalDigest = Object.keys(total).length ? digest(total) : undefined;
    const usageDigest = digest(usage);
    const responseId = native ? string(p.response_id) : "";
    const requestId = native ? string(p.request_id) : "";
    const target = this.messages.findIndex(m => m.key === this.state.targetKey);
    if (target < 0) return true; // A resumed page may begin with a status-only counter.
    if (!native && this.messages[target].role !== "assistant") return true;
    const legacy = `${this.state.targetKey}:${usageDigest}`;
    // Context compaction can reset the UI counter without resetting the native
    // request ledger. Its mirror still describes the same request, even when
    // those two cumulative totals differ. A context-size-only status is not usage.
    const contextSizeOnly = usage.input_tokens === 0 && usage.output_tokens === 0 && Number(usage.total_tokens) > 0;
    if (!native && (contextSizeOnly || usageDigest === this.state.nativeMirror ||
      (totalDigest && totalDigest === this.state.total) || (!totalDigest && legacy === this.state.legacy))) {
      if (totalDigest) this.state.total = totalDigest;
      return true;
    }
    const key = responseId || requestId
      ? `codex-request:${JSON.stringify([requestId, responseId])}`
      : `codex-usage:${digest([this.state.turnId, totalDigest || legacy])}`;
    const entry: HistoryUsageRecord = { key, usage,
      ...(string(row.timestamp) ? { timestamp: string(row.timestamp) } : {}),
      ...(model ? { model } : {}), ...(responseId ? { responseId } : {}), ...(requestId ? { requestId } : {}) };
    const existing = this.entries.get(key), messageIndex = existing?.message ?? target;
    const previous = this.messages[messageIndex];
    const records = [...(previous.usageRecords || [])];
    if (existing) records[existing.index] = entry;
    else { this.entries.set(key, { message: messageIndex, index: records.length }); records.push(entry); }
    const updated = { ...previous, usage: records[0].usage, usageRecords: records };
    this.messages[messageIndex] = updated;
    if (this.archived.has(previous)) this.archived.add(updated);
    this.state.total = totalDigest;
    this.state.legacy = legacy;
    this.state.nativeMirror = native ? usageDigest : undefined;
    return true;
  }
}
