import type Database from "better-sqlite3";
import { HistoryFormatError, record, string, type HistoryMessage, type HistorySession } from "./types.js";
import { timestamp } from "./source-io.js";

export type Row = Record<string, unknown>;
export function array(value: unknown): Row[] { return Array.isArray(value) ? value.map(record) : []; }
export function decode(value: unknown, fallback: unknown = {}): unknown {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string" && !Buffer.isBuffer(value)) return value;
  try { return JSON.parse(String(value)); }
  catch { throw new HistoryFormatError("Invalid transcript JSON; existing data was retained"); }
}
export function at(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, key) => record(v)[key], value);
}
export function first(value: unknown, ...paths: string[]): string {
  for (const path of paths) { const found = string(at(value, path)); if (found) return found; }
  return "";
}
export function message(row: Row, index: number, overrides: Partial<HistoryMessage> = {}): HistoryMessage {
  const usage = record(row.usage);
  return {
    key: string(row.id) || string(row.uuid) || String(index),
    role: string(row.role), content: row.content,
    timestamp: timestamp(row.timestamp ?? row.created_at ?? row.ts),
    model: string(row.model) || undefined,
    usage: Object.keys(usage).length ? usage : undefined,
    raw: row, ...overrides,
  };
}
// Column and table identifiers come only from adapter-owned schema allowlists.
export function table(db: Database.Database, name: string, fields: string[], required: string[] = []): Row[] {
  if (![name, ...fields, ...required].every(n => /^[a-z_][a-z_0-9]*$/i.test(n))) throw new Error("Invalid schema identifier");
  const columns = new Set((db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(c => c.name));
  if (!columns.size || required.some(n => !columns.has(n))) throw new HistoryFormatError(`Unsupported transcript schema: ${name}`);
  const selected = fields.filter(f => columns.has(f));
  if (!selected.length) throw new HistoryFormatError(`Transcript fields are missing: ${name}`);
  return db.prepare(`SELECT ${selected.map(f => `"${f}"`).join(",")} FROM "${name}"`).all() as Row[];
}
export function session(provider: string, id: unknown, cwd: unknown, messages: HistoryMessage[], metadata: Row = {}): HistorySession {
  if (!string(id)) throw new HistoryFormatError("Session identity is missing");
  return { provider, id: string(id), cwd: string(cwd), messages, metadata };
}
export function sorted(rows: Row[], ...fields: string[]): Row[] {
  return rows.sort((a, b) => {
    for (const field of fields) {
      const left = a[field], right = b[field];
      const cmp = typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""));
      if (cmp) return cmp;
    }
    return 0;
  });
}
export function group(rows: Row[], key: string): Map<unknown, Row[]> {
  const result = new Map<unknown, Row[]>();
  for (const row of rows) { const list = result.get(row[key]) || []; list.push(row); result.set(row[key], list); }
  return result;
}

export function requireSession(session: HistorySession): HistorySession {
  if (!session.id)
    throw new HistoryFormatError(
      "Session identity or workspace evidence is missing",
    );
  return session;
}
