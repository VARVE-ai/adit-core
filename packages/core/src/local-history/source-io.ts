import { lstat, open, readdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import Database from "better-sqlite3";
import { HistoryFormatError, jsonDocument } from "./types.js";

export async function readSource(
  path: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  if ((await lstat(path)).isSymbolicLink())
    throw new Error("Symbolic source links are not collected");
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 128 * 1024 * 1024)
      throw new Error("Source is not a regular file within the 128 MiB limit");
    const bytes = await file.readFile({ signal });
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error(
        "Source changed while reading; retry on the next collection",
      );
    return bytes;
  } finally {
    await file.close();
  }
}

export async function readSourceJSON(path: string, signal?: AbortSignal) {
  return jsonDocument((await readSource(path, signal)).toString("utf8"));
}

export async function directoryEntries(path: string) {
  try {
    if ((await lstat(path)).isSymbolicLink()) return [];
    return (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function childPath(root: string, id: string): string {
  if (!id || id.includes("/") || id.includes("\\") || id === "." || id === "..")
    throw new HistoryFormatError("Invalid source identity");
  const path = resolve(root, id);
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    throw new HistoryFormatError("Source identity escapes its directory");
  return path;
}

export async function jsonDirectory(path: string, signal?: AbortSignal) {
  const result: Record<string, unknown>[] = [];
  for (const entry of await directoryEntries(path)) {
    signal?.throwIfAborted();
    if (entry.isFile() && entry.name.endsWith(".json"))
      result.push(await readSourceJSON(join(path, entry.name), signal));
  }
  return result;
}

// A read transaction includes committed WAL pages. Never copy the live DB or read auth tables.
export function databaseSnapshot<T>(
  path: string,
  read: (db: Database.Database) => T,
): T {
  const db = new Database(path, {
    readonly: true,
    fileMustExist: true,
    timeout: 1000,
  });
  try {
    db.pragma("query_only = ON");
    return db.transaction(() => read(db))();
  } finally {
    db.close();
  }
}

export function hasTable(db: Database.Database, table: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
}

export function timestamp(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const date = new Date(typeof value === "number" ? value : String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
