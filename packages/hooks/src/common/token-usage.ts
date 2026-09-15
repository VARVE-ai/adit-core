import { createHash } from "node:crypto";
import { openSync, closeSync, readSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { generateId, insertEventAutoSeq, normalizeUsage, type TokenUsageRecord } from "@varveai/adit-core";
import type { HookContext } from "./context.js";

interface Cursor {
  offset: number;
  generation: string;
  turnId: string | null;
  model: string | null;
  cumulative: string | null;
  enabledAt: string;
  fileIdentity: string;
  discardLine?: boolean;
}

function identity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function saveRecord(ctx: HookContext, record: TokenUsageRecord): void {
  const previous = ctx.db.prepare("SELECT record_json FROM token_usage_records WHERE id = ?").get(record.id) as { record_json: string } | undefined;
  if (previous) {
    const old = JSON.parse(previous.record_json) as TokenUsageRecord;
    record.turnId = old.turnId;
    record.occurredAt = old.occurredAt;
    record.revision = old.revision;
    record.model = old.model ?? record.model;
    record.requestId ??= old.requestId;
    Object.assign(record, normalizeUsage(record.provider, { ...old.raw, ...record.raw }));
    record.complete = record.granularity === "request" && record.totalTokens !== null;
    if (JSON.stringify(record) === JSON.stringify(old)) return;
    record.revision++;
  }
  const serialized = JSON.stringify(record);
  ctx.db.prepare(`INSERT INTO token_usage_records(id, session_id, turn_id, revision, record_json)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, record_json=excluded.record_json`)
    .run(record.id, record.sessionId, record.turnId, record.revision, serialized);
  insertEventAutoSeq(ctx.db, {
    id: generateId(), sessionId: ctx.session.id, parentEventId: record.turnId,
    eventType: "token_usage", actor: "system", status: "success",
    startedAt: record.occurredAt, toolName: "adit.token-usage.v1", toolInputJson: serialized,
    vclockJson: "{}",
  });
}

function makeRecord(ctx: HookContext, cursor: Cursor, key: string, raw: unknown,
  granularity: TokenUsageRecord["granularity"], occurredAt: string,
  responseId: string | null = null, requestId: string | null = null): TokenUsageRecord {
  const provider = ctx.session.platform === "codex" ? "codex" : "claude";
  const normalized = normalizeUsage(provider, raw);
  return {
    schemaVersion: 1, id: identity(`${ctx.session.id}:${key}`), revision: 1,
    sessionId: ctx.session.id, turnId: cursor.turnId, provider, model: cursor.model,
    requestId, responseId, source: "transcript", granularity, occurredAt,
    ...normalized, complete: granularity === "request" && normalized.totalTokens !== null,
  };
}

export function captureTokenUsage(ctx: HookContext, transcriptPath: string | undefined,
  boundary: "prompt" | "stop", turnId?: string): void {
  if (!transcriptPath || !["codex", "claude-code", "claude-vscode"].includes(ctx.session.platform)) return;
  const sourceKey = identity(`${ctx.session.id}:${resolve(transcriptPath)}`);
  ctx.db.transaction(() => {
    const file = existsSync(transcriptPath) ? statSync(transcriptPath) : null;
    if (file && !file.isFile()) return;
    const size = file?.size ?? 0;
    const fileIdentity = file ? `${file.dev}:${file.ino}:${file.birthtimeMs}` : "";
    const now = new Date().toISOString();
    const row = ctx.db.prepare("SELECT state_json FROM token_usage_cursors WHERE source_key = ?").get(sourceKey) as { state_json: string } | undefined;
    const cursor: Cursor = row ? JSON.parse(row.state_json) : {
      offset: size, generation: generateId(), turnId: null, model: null,
      cumulative: null, enabledAt: now, fileIdentity,
    };
    if ((cursor.fileIdentity && cursor.fileIdentity !== fileIdentity) || size < cursor.offset) {
      if (cursor.turnId) saveRecord(ctx, makeRecord(ctx, cursor, `gap:${cursor.turnId}`, {}, "gap", now));
      cursor.offset = size;
      cursor.generation = generateId();
      cursor.cumulative = null;
      cursor.discardLine = false;
    }
    cursor.fileIdentity = fileIdentity;
    const descriptor = file ? openSync(transcriptPath, "r") : null;
    try {
      while (descriptor !== null && cursor.offset < size) {
        const buffer = Buffer.alloc(Math.min(size - cursor.offset, 8 * 1024 * 1024));
        const count = readSync(descriptor, buffer, 0, buffer.length, cursor.offset);
        const newline = buffer.subarray(0, count).lastIndexOf(10);
        if (newline < 0) {
          if (count < 8 * 1024 * 1024) break;
          cursor.offset += count;
          cursor.discardLine = true;
          if (cursor.turnId) saveRecord(ctx, makeRecord(ctx, cursor, `gap:${cursor.turnId}`, {}, "gap", now));
          continue;
        }
        const lines = buffer.subarray(0, newline + 1).toString("utf8").split("\n");
        let position = cursor.offset;
        for (const line of lines) {
          const linePosition = position;
          position += Buffer.byteLength(line, "utf8") + 1;
          if (cursor.discardLine) { cursor.discardLine = false; continue; }
          if (!line.trim()) continue;
          let entry: Record<string, unknown>;
          try { entry = object(JSON.parse(line)); } catch {
            if (cursor.turnId) saveRecord(ctx, makeRecord(ctx, cursor, `gap:${cursor.turnId}`, {}, "gap", now));
            continue;
          }
          const payload = object(entry.payload);
          if (entry.type === "turn_context") cursor.model = text(payload.model) ?? cursor.model;
          if (!cursor.turnId) continue;
          const timestamp = typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp))
            ? new Date(entry.timestamp).toISOString() : now;
          if (timestamp < cursor.enabledAt) continue;
          if (ctx.session.platform !== "codex" && entry.type === "assistant") {
            const message = object(entry.message);
            const responseId = text(message.id);
            if (!responseId) continue;
            cursor.model = text(message.model) ?? cursor.model;
            saveRecord(ctx, makeRecord(ctx, cursor, `response:${responseId}`, message.usage,
              "request", timestamp, responseId, text(entry.requestId)));
          }
          if (ctx.session.platform === "codex" && entry.type === "token_usage_record") {
            const responseId = text(payload.response_id);
            if (responseId) {
              saveRecord(ctx, makeRecord(ctx, cursor, `response:${responseId}`, payload.usage,
                "request", timestamp, responseId));
            }
          }
          if (ctx.session.platform === "codex" && entry.type === "event_msg" && payload.type === "token_count") {
            const info = object(payload.info);
            const cumulative = JSON.stringify(normalizeUsage("codex", info.total_token_usage).raw);
            if (cumulative === "{}" || cumulative === cursor.cumulative) continue;
            cursor.cumulative = cumulative;
            saveRecord(ctx, makeRecord(ctx, cursor, `${sourceKey}:${cursor.generation}:${linePosition}`,
              info.last_token_usage, "observation", timestamp));
          }
        }
        cursor.offset += newline + 1;
      }
    } finally { if (descriptor !== null) closeSync(descriptor); }
    if (cursor.turnId) {
      const count = ctx.db.prepare("SELECT COUNT(*) AS count FROM token_usage_records WHERE session_id = ? AND turn_id = ?")
        .get(ctx.session.id, cursor.turnId) as { count: number };
      if (count.count === 0 || cursor.offset < size) {
        saveRecord(ctx, makeRecord(ctx, cursor, `gap:${cursor.turnId}`, {}, "gap", now));
      }
    }
    if (boundary === "prompt") cursor.turnId = turnId ?? null;
    ctx.db.prepare(`INSERT INTO token_usage_cursors(source_key, session_id, state_json) VALUES (?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET state_json=excluded.state_json`).run(sourceKey, ctx.session.id, JSON.stringify(cursor));
  }).immediate();
}
