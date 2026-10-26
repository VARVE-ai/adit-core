import type Database from "better-sqlite3";
import { record } from "./types.js";

export function nativeContextKind(provider: string, raw: unknown, extra?: unknown): "compaction" | "interruption" | null {
  if (!["codex", "traex", "augure-code"].includes(provider)) return null;
  const row = record(raw), payload = record(row.payload);
  if (record(row.metadata).compaction_output === true || record(extra).contextKind === "compaction") return "compaction";
  const kinds = record(payload.internal_chat_message_metadata_passthrough).content_item_kinds;
  return Array.isArray(kinds) && kinds.includes("generic.turn_aborted") ? "interruption" : null;
}

/** Native flags only: ordinary replies discussing compaction remain ordinary replies. */
export function nativeContextSql(alias = "m"): string {
  if (!/^[a-z]+$/i.test(alias)) throw new Error("Invalid SQL alias");
  return `(${alias}.provider IN ('codex','traex','augure-code') AND (
    coalesce(json_extract(${alias}.raw_json,'$.metadata.compaction_output'),0)=1 OR
    coalesce(json_extract(${alias}.extra_json,'$.contextKind'),'')='compaction' OR
    EXISTS(SELECT 1 FROM json_each(${alias}.raw_json,'$.payload.internal_chat_message_metadata_passthrough.content_item_kinds') WHERE value='generic.turn_aborted')))`;
}

/** Older Codex logs identify the generated answer in the following compacted record. */
export function isCompactedReply(row: Record<string,unknown>, candidate: Record<string,unknown> | undefined): boolean {
  if(row.type!=="compacted" || !candidate)return false;
  const payload=record(candidate.payload);
  if(payload.type!=="message" || payload.role!=="assistant")return false;
  const content=payload.content;
  const text=(typeof content==="string"?content:Array.isArray(content)?content.map(b=>record(b).text).filter(t=>typeof t==="string").join("\n"):"").trim();
  const message=record(row.payload).message;
  return !!text && typeof message==="string" && (message.trim()===text || message.trim().endsWith("\n"+text));
}

type Candidate = {id:string;ordinal:number;occurred_at:number|null;phase:string|null;stop:string|null;explicit:number;tool_after:number};
export function replyCompleted(phase: unknown, stop: unknown, explicit: boolean, hasNextTurn: boolean, toolAfter: boolean) {
  if (["analysis", "commentary"].includes(phase as string) || stop === "tool_use" || stop === "tool_calls") return false;
  return ["final", "final_answer"].includes(phase as string) || ["end_turn", "stop", "stop_sequence"].includes(stop as string) || explicit || (hasNextTurn && !toolAfter);
}

/** Prefer the native task completion; context output never displaces a real answer.
 * Only metadata leaves SQLite, so pending counters don't load transcript bodies. */
export function historyFinalReply(db: Database.Database, turnId: string, hasNextTurn: boolean): Candidate | undefined {
  const candidate = db.prepare(`WITH candidate AS (
    SELECT m.id,m.ordinal,m.occurred_at,m.raw_json,m.extra_json,
      CASE WHEN json_type(m.raw_json,'$.payload') IS NOT NULL AND json_type(m.raw_json,'$.payload')<>'null' THEN '$.payload'
        WHEN json_type(m.raw_json,'$.message') IS NOT NULL AND json_type(m.raw_json,'$.message')<>'null' THEN '$.message' ELSE '$' END prefix
    FROM adit_history_messages m WHERE m.turn_id=? AND m.role='assistant' AND NOT ${nativeContextSql()}
      AND NOT EXISTS(SELECT 1 FROM adit_history_tool_calls c WHERE c.message_id=m.id)
      AND EXISTS(SELECT 1 FROM adit_history_blocks b LEFT JOIN adit_history_text_edits e
        ON e.provider=m.provider AND e.session_id=m.session_id AND e.message_key=m.source_key AND e.block_index=b.block_index
        WHERE b.message_id=m.id AND b.kind IN ('text','input_text','output_text') AND trim(coalesce(e.text_content,b.text_content,''))<>'')
    ORDER BY coalesce(json_extract(m.extra_json,'$.finalReply'),0) DESC,m.ordinal DESC LIMIT 1)
    SELECT id,ordinal,occurred_at,
      coalesce(json_extract(raw_json,prefix||'.phase'),json_extract(raw_json,prefix||'.channel'),json_extract(raw_json,'$.phase')) phase,
      coalesce(json_extract(raw_json,prefix||'.stop_reason'),json_extract(raw_json,prefix||'.finish_reason'),json_extract(raw_json,'$.finish_reason')) stop,
      json_type(extra_json,'$.finalReply')='true' explicit,
      EXISTS(SELECT 1 FROM adit_history_messages later WHERE later.turn_id=? AND later.ordinal>candidate.ordinal
        AND (later.role='tool' OR EXISTS(SELECT 1 FROM adit_history_tool_calls c WHERE c.message_id=later.id))) tool_after
    FROM candidate`).get(turnId,turnId) as Candidate | undefined;
  if(candidate && replyCompleted(candidate.phase,candidate.stop,!!candidate.explicit,hasNextTurn,!!candidate.tool_after))return candidate;
}

/** Shared by session browsing and share previews: keep the same closing reply. */
export function focusedReplyId(db: Database.Database, provider: string, turnId: string | null,
  rows: Iterable<{ message_id: string; role: string; kind: string; text_length: number | null; tool_id?: unknown; native_context?: unknown }>): string | null {
  const keepBeforeTools = ["codex", "traex", "augure-code"].includes(provider);
  let last: string | null = null;
  for (const row of rows) {
    if (row.native_context) continue;
    if (row.tool_id || /tool|function_call/.test(row.kind) || row.role === "tool") {
      if (!keepBeforeTools) last = null;
    } else if (row.role === "assistant" && ["text", "output_text"].includes(row.kind) && row.text_length)
      last = row.message_id;
  }
  // Browsing supports older logs without explicit completion annotations.
  return keepBeforeTools && turnId ? historyFinalReply(db, turnId, true)?.id || last : last;
}
