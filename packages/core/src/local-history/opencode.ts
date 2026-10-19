import { basename, dirname, join } from "node:path";
import type Database from "better-sqlite3";
import {
  databaseSnapshot,
  hasTable,
  childPath,
  jsonDirectory,
  readSourceJSON,
  timestamp,
} from "./source-io.js";
import {
  HistoryFormatError,
  jsonDocument,
  record,
  string,
  type HistoryMessage,
  type HistorySession,
} from "./types.js";
import { insideDirectory } from "./sources.js";

function message(
  id: string,
  data: Record<string, unknown>,
  parts: Record<string, unknown>[],
  created: unknown,
  kind?: string,
): HistoryMessage {
  const model = record(data.model);
  const tokens = record(data.tokens);
  // Message totals override step-finish totals; they are not two separate charges.
  const usage = Object.keys(tokens).length
    ? tokens
    : record(
        [...parts].reverse().find((p) => p.type === "step-finish")?.tokens,
      );
  const role = kind || string(data.role);
  return {
    key: id,
    role,
    model:
      string(data.modelID) ||
      string(model.modelID) ||
      string(model.id) ||
      undefined,
    timestamp: timestamp(created),
    content: kind ? (data.content ?? data.text ?? data.summary ?? data) : parts,
    usage: Object.keys(usage).length ? usage : undefined,
    raw: { ...data, parts },
  };
}

function rows(db: Database.Database, table: "session" | "session_v2") {
  return hasTable(db, table)
    ? (db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<
        string,
        unknown
      >[])
    : [];
}

export function readOpenCodeDatabase(
  path: string,
  provider: string,
  workspace: string,
  signal?: AbortSignal,
): HistorySession[] {
  return databaseSnapshot(path, (db) => {
    const current = rows(db, "session_v2");
    let legacy = rows(db, "session");
    if (!hasTable(db, "session") && !hasTable(db, "session_v2"))
      throw new HistoryFormatError("OpenCode session tables are missing");
    if (hasTable(db, "kv")) {
      const migration = db
        .prepare("SELECT value FROM kv WHERE key='migration.v1-v2'")
        .get() as { value: string } | undefined;
      if (migration) {
        let value: unknown;
        try {
          value = JSON.parse(migration.value);
        } catch {
          throw new HistoryFormatError("Invalid OpenCode migration state");
        }
        const state = record(value);
        if (state.phase === "completed") legacy = [];
        else if (state.phase === "sessions" && string(state.cursor))
          legacy = legacy.filter((s) => string(s.id) < string(state.cursor));
      }
    }
    const ids = new Set(current.map((s) => s.id));
    const sessions = [...current, ...legacy.filter((s) => !ids.has(s.id))];
    const result: HistorySession[] = [];
    for (const s of sessions) {
      signal?.throwIfAborted();
      const id = string(s.id);
      let cwd = string(s.directory);
      if ((!cwd || cwd === "/") && hasTable(db, "project")) {
        const project = db
          .prepare("SELECT worktree FROM project WHERE id=?")
          .get(s.project_id) as { worktree: string } | undefined;
        cwd = project?.worktree || cwd;
      }
      if (!id || !cwd || cwd === "/" || !insideDirectory(workspace, cwd))
        continue;
      const messages = new Map<string, HistoryMessage>();
      const projected: HistoryMessage[] = [];
      if (!ids.has(id) && hasTable(db, "message")) {
        const sourceMessages = db
          .prepare(
            "SELECT id,data,time_created FROM message WHERE session_id=? ORDER BY time_created,id",
          )
          .all(id) as { id: string; data: string; time_created: number }[];
        const parts = hasTable(db, "part")
          ? (db
              .prepare(
                "SELECT message_id,data FROM part WHERE session_id=? ORDER BY time_created,id",
              )
              .all(id) as { message_id: string; data: string }[])
          : [];
        const byMessage = new Map<string, Record<string, unknown>[]>();
        for (const p of parts)
          byMessage.set(p.message_id, [
            ...(byMessage.get(p.message_id) || []),
            jsonDocument(p.data),
          ]);
        for (const m of sourceMessages) {
          messages.set(
            m.id,
            message(
              m.id,
              jsonDocument(m.data),
              byMessage.get(m.id) || [],
              m.time_created,
            ),
          );
        }
      }
      if (hasTable(db, "session_message")) {
        const columns = db
          .prepare("PRAGMA table_info(session_message)")
          .all() as { name: string }[];
        const hasSeq = columns.some((c) => c.name === "seq");
        const projection = db
          .prepare(
            `SELECT id,type,data,time_created${hasSeq ? ",seq" : ""} FROM session_message WHERE session_id=? ORDER BY ${hasSeq ? "seq" : "time_created"},id`,
          )
          .all(id) as {
          id: string;
          type: string;
          data: string;
          time_created: number;
          seq?: number;
        }[];
        // Projection rows replace matching legacy rows during a rolling schema migration.
        for (const m of projection) {
          if (
            ![
              "user",
              "assistant",
              "system",
              "synthetic",
              "skill",
              "compaction",
              "shell",
            ].includes(m.type)
          )
            continue;
          messages.delete(m.id);
          projected.push(
            message(m.id, jsonDocument(m.data), [], m.time_created, m.type),
          );
        }
      }
      const legacyMessages = [...messages.values()];
      const merged: HistoryMessage[] = [];
      let index = 0;
      for (const m of projected) {
        while (
          index < legacyMessages.length &&
          (legacyMessages[index].timestamp || "") <= (m.timestamp || "")
        )
          merged.push(legacyMessages[index++]);
        merged.push(m);
      }
      merged.push(...legacyMessages.slice(index));
      result.push({
        id,
        provider,
        cwd,
        parentId: string(s.parent_id) || undefined,
        messages: merged,
      });
    }
    return result;
  });
}

function time(data: Record<string, unknown>, part = false): number {
  const t = record(data.time);
  return Number(
    (part ? (t.start ?? t.created) : (t.created ?? t.start)) ??
      t.end ??
      t.updated ??
      0,
  );
}

export async function readOpenCodeStorage(
  path: string,
  provider: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<HistorySession[]> {
  const data = await readSourceJSON(path, signal);
  const id = string(data.id);
  if (!id) throw new HistoryFormatError("OpenCode session identity is missing");
  const root = dirname(dirname(dirname(dirname(path))));
  let cwd = string(data.directory);
  if (!cwd || cwd === "/") {
    try {
      cwd = string(
        (
          await readSourceJSON(
            join(root, "storage/project", `${basename(dirname(path))}.json`),
            signal,
          )
        ).worktree,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!cwd || cwd === "/" || !insideDirectory(workspace, cwd)) return [];
  const sourceMessages = await jsonDirectory(
    childPath(join(root, "storage/message"), id),
    signal,
  );
  sourceMessages.sort(
    (a, b) => time(a) - time(b) || string(a.id).localeCompare(string(b.id)),
  );
  const messages: HistoryMessage[] = [];
  for (const m of sourceMessages) {
    const messageId = string(m.id);
    if (!messageId || (m.sessionID && m.sessionID !== id))
      throw new HistoryFormatError("Invalid OpenCode message identity");
    const parts = await jsonDirectory(
      childPath(join(root, "storage/part"), messageId),
      signal,
    );
    if (
      parts.some(
        (p) =>
          (p.messageID && p.messageID !== messageId) ||
          (p.sessionID && p.sessionID !== id),
      )
    )
      throw new HistoryFormatError("OpenCode part belongs to another message");
    parts.sort(
      (a, b) =>
        time(a, true) - time(b, true) ||
        string(a.id).localeCompare(string(b.id)),
    );
    messages.push(message(messageId, m, parts, time(m)));
  }
  return [
    {
      id,
      provider,
      cwd,
      parentId: string(data.parentID) || undefined,
      messages,
    },
  ];
}
