import { lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { databaseSnapshot, readSource, timestamp } from "./source-io.js";
import { trackSource } from "./source-checkpoints.js";
import { decode, message, session, type Row } from "./provider-common.js";
import { HistoryFormatError, jsonLines, record, string, type HistorySession } from "./types.js";
import type { MetadataResult } from "./discovery-metadata.js";

/** IDE history files have a short ID; only the catalog can supply their full identity/cwd. */
function location(path: string) {
  const short = basename(path, ".jsonl"), history = dirname(dirname(path));
  const projects = dirname(dirname(history)), profile = dirname(dirname(projects));
  if (!path.endsWith(".jsonl") || basename(dirname(path)) !== short ||
      basename(history) !== "conversation-history" || basename(projects) !== "projects" ||
      basename(dirname(projects)) !== "cache" || basename(profile) !== ".qoder" ||
      !/^(?:[a-f\d]{8}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(short)) return;
  return { short, home: dirname(profile) };
}

export function isQoderDesktopTranscript(path: string): boolean { return !!location(path); }

function databasePaths(home: string): string[] {
  const roaming = resolve(home).toLowerCase() === resolve(homedir()).toLowerCase() && process.env.APPDATA
    ? process.env.APPDATA : join(home, "AppData", "Roaming");
  return [join(roaming, "Qoder"), join(home, "Library", "Application Support", "Qoder"), join(home, ".config", "Qoder")]
    .map(root => join(root, "SharedClientCache", "cache", "db", "local.db"));
}

function selectColumns(db: Database.Database, name: string, fields: string[], required: string[]): string {
  const columns = new Set((db.prepare(`PRAGMA table_info(${name})`).all() as {name: string}[]).map(r => r.name));
  if (required.some(field => !columns.has(field))) throw new HistoryFormatError(`Unsupported Qoder desktop schema: ${name}`);
  return fields.filter(field => columns.has(field)).map(field => `"${field}"`).join(",");
}

async function catalog(path: string, withMessages: boolean, signal?: AbortSignal) {
  const loc = location(path);
  if (!loc) throw new HistoryFormatError("Unsupported Qoder desktop transcript path");
  const matches: {row: Row; messages: Row[]}[] = [];
  for (const database of databasePaths(loc.home)) {
    signal?.throwIfAborted();trackSource(database);trackSource(`${database}-wal`);
    try { if ((await lstat(database)).isSymbolicLink()) throw new HistoryFormatError("Symbolic Qoder databases are not collected"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;throw error; }
    const found = databaseSnapshot(database, db => {
      const columns = selectColumns(db, "chat_session", ["session_id", "session_title", "project_uri", "project_id", "gmt_create", "gmt_modified", "parent_session_id"], ["session_id", "project_uri"]);
      const rows = db.prepare(`SELECT ${columns} FROM chat_session WHERE session_id>=? AND session_id<? LIMIT 2`).all(loc.short, loc.short + "\uffff") as Row[];
      return rows.map(row => {
        if (!withMessages) return {row, messages: [] as Row[]};
        // Do not select encrypted content, prompts, credentials or account data.
        const fields = selectColumns(db, "chat_message", ["id", "request_id", "role", "gmt_create", "token_info", "model_info"], ["id", "session_id", "role", "gmt_create"]);
        const messages = db.prepare(`SELECT ${fields} FROM chat_message WHERE session_id=? ORDER BY gmt_create,rowid`).all(row.session_id) as Row[];
        return {row, messages};
      });
    });
    matches.push(...found);
  }
  if (matches.length > 1) throw new HistoryFormatError("Qoder desktop session prefix is ambiguous; existing data was retained");
  return matches[0];
}

function cwd(row: Row): string {
  const path = string(row.project_uri) || string(row.project_id);
  return path.startsWith("file:") ? fileURLToPath(path) : path;
}

export async function qoderDesktopMetadata(path: string, signal?: AbortSignal): Promise<MetadataResult> {
  const found = await catalog(path, false, signal);
  if (!found || !cwd(found.row)) return {sessions: [], pending: true};
  const row = found.row;
  return {sessions: [{id: string(row.session_id), cwd: cwd(row), ...(row.parent_session_id ? {parentId: string(row.parent_session_id), relationship: "subagent"} : {})}]};
}

function userContent(content: unknown): unknown {
  const clean = (text: string) => /^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/.exec(text)?.[1] ?? text;
  if (typeof content === "string") return clean(content);
  if (!Array.isArray(content)) return content;
  return content.map(block => {
    const value = record(block);
    return ["text", "input_text"].includes(string(value.type)) && typeof value.text === "string"
      ? {...value, text: clean(value.text)} : block;
  });
}

function nativeUsage(value: unknown): Row | undefined {
  const raw = record(decode(value));
  if (!Object.keys(raw).length) return;
  const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const input = count(raw.prompt_tokens), cached = count(raw.cached_tokens), output = count(raw.completion_tokens);
  // Desktop uses OpenAI-style inclusive prompt tokens, unlike Qoder CLI's Claude format.
  return {native: raw, adit_input_semantics: "includes_cache", ...(input !== undefined ? {input_tokens: input} : {}),
    ...(cached !== undefined ? {cache_read_input_tokens: cached} : {}), ...(output !== undefined ? {output_tokens: output} : {})};
}

export async function readQoderDesktop(path: string, signal?: AbortSignal): Promise<HistorySession[]> {
  const found = await catalog(path, true, signal);
  if (!found || !cwd(found.row)) throw new HistoryFormatError("Qoder desktop session metadata is not available yet; retry on the next collection");
  const rows = jsonLines((await readSource(path, signal)).toString("utf8"));
  for (const row of rows) if (!["user", "assistant", "tool", "system"].includes(string(row.role)) || record(row.message).content === undefined)
    throw new HistoryFormatError("Unsupported Qoder desktop message; existing data was retained");
  // The cache lacks native message IDs. Only a complete matching role sequence can
  // associate timestamps/usage with individual messages; never match by time alone.
  const aligned = rows.length === found.messages.length && rows.every((row, index) => row.role === found.messages[index].role);
  if (!aligned) throw new HistoryFormatError("Qoder desktop transcript and message metadata are not synchronized; retry on the next collection");
  if (!rows.length) return [];
  const messages = rows.map((row, index) => {
    signal?.throwIfAborted();
    const wire = record(row.message), native = found.messages[index], model = record(decode(native.model_info));
    return message(row, index, {key: `desktop:${index}`, role: string(row.role),
      content: row.role === "user" ? userContent(wire.content) : wire.content,
      timestamp: timestamp(native.gmt_create), model: string(model.model_key) || undefined,
      usage: nativeUsage(native.token_info), raw: {...row, nativeMessageId: native.id, requestId: native.request_id}});
  });
  const result = session("qoder", found.row.session_id, cwd(found.row), messages,
    {title: found.row.session_title, nativeFormat: "qoder-desktop-cache", nativeMetadataAligned: aligned});
  if (found.row.parent_session_id) { result.parentId = string(found.row.parent_session_id);result.relationship = "subagent"; }
  return [result];
}
