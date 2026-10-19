import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  realpathSync,
  statSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";

export interface LocalWorkspace {
  id: string;
  name: string;
  path: string;
  version: number;
  started: boolean;
  providers: string[];
  repositories: string[];
  cloud: { enabled: boolean; mode: "manual" | "automatic"; interval: number };
  updatedAt: string;
}
export interface LocalProvider {
  id: string;
  enabled: boolean;
  homes: string[];
  version: number;
}
export interface LocalSchedule {
  enabled: boolean;
  interval: number;
  version: number;
}
export class LocalStateError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function localDataDir(): string {
  return resolve(process.env.ADIT_LOCAL_DATA_DIR || join(homedir(), ".adit"));
}
export function canonicalDirectory(path: string): string {
  if (typeof path !== "string" || !path.trim())
    throw new LocalStateError("Directory is required");
  const normalized = realpathSync(resolve(path.trim()));
  if (!statSync(normalized).isDirectory())
    throw new LocalStateError("Not a directory");
  return normalized;
}
function list(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || !v.trim())
  )
    throw new LocalStateError("Expected a list of non-empty strings");
  return [...new Set(value)];
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new LocalStateError("Expected a boolean");
  return value;
}
function interval(value: unknown, allowed: number[]): number {
  if (typeof value !== "number" || !allowed.includes(value))
    throw new LocalStateError("Invalid interval");
  return value;
}
export class LocalStore {
  readonly db: Database.Database;
  readonly dbPath: string;
  constructor(readonly directory = localDataDir()) {
    mkdirSync(directory, { recursive: true });
    this.dbPath = join(directory, "local.sqlite");
    this.db = new Database(this.dbPath);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    const commitColumns=this.db.prepare("PRAGMA table_info(adit_local_commits)").all() as {name:string}[];
    if(commitColumns.some(column=>column.name==="data")) {
      this.db.close();
      throw new LocalStateError("The development collection schema changed. Clear collected commits and history, then collect again; automatic migration is disabled.");
    }
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS adit_local_identity (kind TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS adit_local_workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS adit_local_settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS adit_local_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS adit_local_repositories (
        path TEXT PRIMARY KEY, indexed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS adit_local_commits (
        repository TEXT NOT NULL, sha TEXT NOT NULL, tree_sha TEXT NOT NULL,
        authored_at INTEGER, author_name TEXT NOT NULL, author_email TEXT NOT NULL,
        committed_at INTEGER, committer_name TEXT NOT NULL, committer_email TEXT NOT NULL,
        subject TEXT NOT NULL, body TEXT NOT NULL, indexed_at INTEGER NOT NULL,
        PRIMARY KEY(repository,sha)
      );
      CREATE INDEX IF NOT EXISTS adit_local_commits_time ON adit_local_commits(repository,committed_at DESC,sha);
      CREATE TABLE IF NOT EXISTS adit_local_commit_parents (
        repository TEXT NOT NULL, sha TEXT NOT NULL, parent_sha TEXT NOT NULL, ordinal INTEGER NOT NULL,
        PRIMARY KEY(repository,sha,ordinal),
        FOREIGN KEY(repository,sha) REFERENCES adit_local_commits(repository,sha) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS adit_local_commit_files (
        repository TEXT NOT NULL, sha TEXT NOT NULL, ordinal INTEGER NOT NULL,
        old_path TEXT, path TEXT NOT NULL, additions INTEGER, deletions INTEGER, binary INTEGER NOT NULL,
        PRIMARY KEY(repository,sha,ordinal),
        FOREIGN KEY(repository,sha) REFERENCES adit_local_commits(repository,sha) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS adit_local_commit_files_path ON adit_local_commit_files(repository,path,sha);
    `);
  }
  close(): void {
    this.db.close();
  }
  identity(kind: string, seed?: string): string {
    return this.db
      .transaction(() => {
        const found = this.db
          .prepare("SELECT value FROM adit_local_identity WHERE kind=?")
          .get(kind) as { value: string } | undefined;
        if (found) return found.value;
        const value = seed || randomUUID().replaceAll("-", "").slice(0, 16);
        this.db
          .prepare("INSERT INTO adit_local_identity VALUES (?,?)")
          .run(kind, value);
        return value;
      })
      .immediate();
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT data FROM adit_local_settings WHERE key=?")
      .get(key) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : fallback;
  }
  set(key: string, data: unknown): void {
    this.db
      .prepare(
        "INSERT INTO adit_local_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(key, JSON.stringify(data));
  }
  workspaces(): LocalWorkspace[] {
    return (
      this.db
        .prepare("SELECT data FROM adit_local_workspaces ORDER BY rowid")
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  workspace(id: string): LocalWorkspace {
    const row = this.db
      .prepare("SELECT data FROM adit_local_workspaces WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new LocalStateError("Workspace not found", 404);
    return JSON.parse(row.data);
  }
  saveWorkspace(input: Record<string, unknown>, id?: string): LocalWorkspace {
    return this.db
      .transaction(() => {
        const old = id ? this.workspace(id) : undefined;
        if (old && input.version !== old.version)
          throw new LocalStateError(
            "Settings changed in another window. Reload before saving.",
            409,
          );
        const path = canonicalDirectory(String(input.path ?? old?.path ?? ""));
        const key = process.platform === "win32" ? path.toLowerCase() : path;
        const duplicate = this.db
          .prepare("SELECT id FROM adit_local_workspaces WHERE path=?")
          .get(key) as { id: string } | undefined;
        if (duplicate && duplicate.id !== id)
          throw new LocalStateError("Workspace already exists", 409);
        const name = String(input.name ?? old?.name ?? basename(path)).trim();
        if (!name || name.length > 200)
          throw new LocalStateError("Name must contain 1 to 200 characters");
        const providers = list(input.providers ?? old?.providers ?? []);
        const repositories = list(
          input.repositories ?? old?.repositories ?? [],
        );
        const cloud = (input.cloud ??
          old?.cloud ?? {
            enabled: false,
            mode: "manual",
            interval: 5,
          }) as Record<string, unknown>;
        if (!cloud || !["manual", "automatic"].includes(String(cloud.mode)))
          throw new LocalStateError("Invalid cloud mode");
        const workspace: LocalWorkspace = {
          id: old?.id ?? `p_${randomUUID()}`,
          name,
          path,
          version: (old?.version ?? 0) + 1,
          started: old?.started ?? false,
          providers,
          repositories,
          cloud: {
            enabled: flag(cloud.enabled),
            mode: cloud.mode as "manual" | "automatic",
            interval: interval(cloud.interval, [5, 15, 30, 60]),
          },
          updatedAt: new Date().toISOString(),
        };
        this.db
          .prepare(
            "INSERT INTO adit_local_workspaces VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,data=excluded.data",
          )
          .run(workspace.id, key, JSON.stringify(workspace));
        return workspace;
      })
      .immediate();
  }
  markStarted(id: string): void {
    const w = this.workspace(id);
    w.started = true;
    this.db
      .prepare("UPDATE adit_local_workspaces SET data=? WHERE id=?")
      .run(JSON.stringify(w), id);
  }
  schedule(): LocalSchedule {
    return this.get("schedule", { enabled: true, interval: 5, version: 0 });
  }
  saveSchedule(input: Record<string, unknown>): LocalSchedule {
    return this.db
      .transaction(() => {
        const old = this.schedule();
        if (input.version !== old.version)
          throw new LocalStateError(
            "Schedule changed. Reload before saving.",
            409,
          );
        const next = {
          enabled: flag(input.enabled),
          interval: interval(input.interval, [1, 5, 15, 30]),
          version: old.version + 1,
        };
        this.set("schedule", next);
        return next;
      })
      .immediate();
  }
  provider(id: string): LocalProvider {
    return this.get(`provider:${id}`, {
      id,
      enabled: true,
      homes: [],
      version: 0,
    });
  }
  saveProvider(id: string, input: Record<string, unknown>): LocalProvider {
    return this.db
      .transaction(() => {
        const old = this.provider(id);
        if (input.version !== old.version)
          throw new LocalStateError(
            "Provider settings changed. Reload before saving.",
            409,
          );
        const homes = list(input.homes).map(canonicalDirectory);
        const keys = homes.map((v) =>
          process.platform === "win32" ? v.toLowerCase() : v,
        );
        if (new Set(keys).size !== keys.length)
          throw new LocalStateError("Duplicate source directory");
        const next = {
          id,
          enabled: flag(input.enabled),
          homes,
          version: old.version + 1,
        };
        this.set(`provider:${id}`, next);
        return next;
      })
      .immediate();
  }
  job<T extends { id: string }>(job: T): void {
    this.db
      .prepare(
        "INSERT INTO adit_local_jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(job.id, JSON.stringify(job));
  }
  jobs<T>(): T[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM adit_local_jobs ORDER BY rowid DESC LIMIT 100",
        )
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
}

export function getLocalClientId(): string {
  const store = new LocalStore();
  try {
    // Preserve the device identity only; no project history or credentials are imported.
    const legacy = join(store.directory, "client-id");
    const seed = existsSync(legacy)
      ? readFileSync(legacy, "utf8").trim()
      : undefined;
    return store.identity("client", seed || undefined);
  } finally {
    store.close();
  }
}
