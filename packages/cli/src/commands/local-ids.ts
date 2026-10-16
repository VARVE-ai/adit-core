/**
 * Resolve the short IDs the CLI prints (the first 10 characters of a ULID)
 * back to full local IDs, so every local command accepts what another one
 * showed. Full IDs always match exactly; a prefix must name exactly one row.
 */

import type Database from "better-sqlite3";
import { printError, shortId, strong } from "./cli-style.js";

export type LocalIdTable = "events" | "sessions" | "env_snapshots";

export type LocalIdLookup =
  | { kind: "found"; id: string }
  | { kind: "missing" }
  | { kind: "ambiguous"; candidates: string[] };

/** Shortest prefix accepted, so a stray character does not match a random row. */
export const MIN_ID_PREFIX = 4;

const SOFT_DELETED: Record<LocalIdTable, boolean> = {
  events: true,
  sessions: false,
  env_snapshots: false,
};

export function resolveLocalId(db: Database.Database, table: LocalIdTable, input: string): LocalIdLookup {
  const value = input.trim();
  if (!value) return { kind: "missing" };

  const exact = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(value) as { id: string } | undefined;
  if (exact) return { kind: "found", id: exact.id };
  if (value.length < MIN_ID_PREFIX) return { kind: "missing" };

  const live = SOFT_DELETED[table] ? " AND deleted_at IS NULL" : "";
  const rows = db
    .prepare(`SELECT id FROM ${table} WHERE upper(substr(id, 1, ?)) = upper(?)${live} ORDER BY id DESC LIMIT 6`)
    .all(value.length, value) as Array<{ id: string }>;
  if (rows.length === 1 && rows[0]) return { kind: "found", id: rows[0].id };
  if (rows.length === 0) return { kind: "missing" };
  return { kind: "ambiguous", candidates: rows.map((row) => row.id) };
}

const NOUNS: Record<LocalIdTable, string> = {
  events: "event",
  sessions: "session",
  env_snapshots: "snapshot",
};

/**
 * Resolve `input` or print the shared error (unknown or ambiguous ID) and
 * set a failing exit code. Returns null when the command should stop.
 */
export function resolveLocalIdOrReport(
  db: Database.Database,
  table: LocalIdTable,
  input: string,
  command: string,
  hint: string,
): string | null {
  const lookup = resolveLocalId(db, table, input);
  if (lookup.kind === "found") return lookup.id;
  const noun = NOUNS[table];
  if (lookup.kind === "ambiguous") {
    const count = lookup.candidates.length >= 6 ? "6 or more" : String(lookup.candidates.length);
    const examples = lookup.candidates.slice(0, 3).map((id) => strong(shortId(id, Math.min(id.length, input.trim().length + 4))));
    printError(command, `${input} matches ${count} ${noun}s`, `use more characters, e.g. ${examples.join(", ")}`);
  } else {
    printError(command, `${noun} ${input} not found`, hint);
  }
  process.exitCode = 1;
  return null;
}
