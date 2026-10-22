import Database from "better-sqlite3";
import { assertDeletionIdle, deleteProjectData, projectDeletionPlan } from "./local-project-deletion.js";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  realpathSync,
  statSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";
import { generateProjectId, readProjectManifest, readWorkspaceManifest, workspaceManifestRelativePath } from "./config/project.js";
import { assertProjectIdle, createProjectRegistry, pathKey, relocatedRepositories, relocateProjectHistory, saveProjectRepositories } from "./local-projects.js";

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
/** Read-only consent check for hook processes. Never creates a local database. */
export function localLoginStartupEnabled(directory = localDataDir()): boolean {
  const path = join(directory, "local.sqlite");
  if (!existsSync(path)) return false;
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1000 });
    const row = db.prepare("SELECT data FROM adit_local_settings WHERE key='login-startup'").get() as { data: string } | undefined;
    const settings = row ? JSON.parse(row.data) : null;
    return settings?.enabled === true && typeof settings.registration === "string" && existsSync(settings.registration);
  } catch { return false; }
  finally { db?.close(); }
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

/** Recover saved identity without initializing or migrating the old database. */
function savedLegacyProjectId(root: string): string | undefined {
  const workspace = readWorkspaceManifest(root);
  if (workspace) return workspace.workspaceId;
  const dbPath = join(root, ".adit", "adit.sqlite");
  if (existsSync(dbPath) && statSync(dbPath).size > 0) {
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      // Older releases may only have one of these tables. Link identity takes
      // precedence, as in the original CLI's initialization path.
      for (const table of ["project_link_cache", "sessions"]) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {name: string}[];
        if (!columns.some(column => column.name === "project_id")) continue;
        const ids = db.prepare(`SELECT DISTINCT project_id FROM ${table} WHERE trim(coalesce(project_id,'')) <> '' LIMIT 2`).all() as {project_id: string}[];
        if (ids.length > 1) throw new LocalStateError("Saved ADIT history contains multiple project identities. Restore the original project configuration.", 409);
        if (ids.length === 1) return ids[0].project_id;
      }
    } catch (error) {
      if (error instanceof LocalStateError) throw error;
      throw new LocalStateError("Unable to read the saved ADIT project identity. Check the local database.", 409);
    } finally { db?.close(); }
  }
  if (existsSync(join(root, workspaceManifestRelativePath)))
    throw new LocalStateError("The saved ADIT workspace configuration is unreadable. Check .adit/workspace.json.", 409);
  // A directory, or an empty database, is not evidence of a lost identity.
  return undefined;
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
      CREATE TABLE IF NOT EXISTS adit_local_git_checkpoints (
        repository TEXT PRIMARY KEY, identity TEXT NOT NULL, refs TEXT NOT NULL, commit_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS adit_local_collection_checkpoints (
        workspace_id TEXT PRIMARY KEY REFERENCES adit_local_workspaces(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL
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
    createProjectRegistry(this.db);
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
        // All callers (including device login) preserve the original machine identity.
        const legacy = join(this.directory, "client-id");
        const value = seed || (kind === "client" && existsSync(legacy) ? readFileSync(legacy, "utf8").trim() : "") ||
          (kind === "client" ? createHash("sha256").update(`${homedir()}-${process.pid}-${Date.now()}`).digest("hex").slice(0,16) : randomUUID().replaceAll("-", "").slice(0,16));
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
        const manifest = readProjectManifest(path);
        const legacyProjectId = !manifest ? savedLegacyProjectId(path) : undefined;
        if (manifest?.mergedIntoProjectId)
          throw new LocalStateError("This directory belongs to its parent ADIT project. Register the parent directory.", 409);
        if (old && (manifest?.projectId ?? legacyProjectId) && (manifest?.projectId ?? legacyProjectId) !== old.id)
          throw new LocalStateError("Project identity conflicts with the registered workspace. Choose the original project's directory.", 409);
        const projectId = old?.id ?? manifest?.projectId ?? legacyProjectId ?? generateProjectId();
        if (!old && this.db.prepare("SELECT 1 FROM adit_local_workspaces WHERE id=?").get(projectId))
          throw new LocalStateError("This project is already registered. Update its directory in Settings.",409);
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
        const selection = list(
          input.repositories ?? old?.repositories ?? [],
        );
        const repositories = old ? relocatedRepositories(old,path,selection) : selection;
        const cloud = (input.cloud ??
          old?.cloud ?? {
            enabled: false,
            mode: "manual",
            interval: 5,
          }) as Record<string, unknown>;
        if (!cloud || !["manual", "automatic"].includes(String(cloud.mode)))
          throw new LocalStateError("Invalid cloud mode");
        const workspace: LocalWorkspace = {
          id: projectId,
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
        if (workspace.cloud.mode === "automatic" && !this.get("login-startup", { enabled: false }).enabled)
          throw new LocalStateError('Enable "Start automatically when you sign in" before automatic cloud sync', 409);
        if (old && pathKey(old.path) !== pathKey(path)) {
          assertProjectIdle(this.db,old.id);
          relocateProjectHistory(this.db,old,workspace);
        }
        this.db
          .prepare(
            "INSERT INTO adit_local_workspaces VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,data=excluded.data",
          )
          .run(workspace.id, key, JSON.stringify(workspace));
        saveProjectRepositories(this.db,workspace,manifest,!!legacyProjectId);
        return workspace;
      })
      .immediate();
  }
  deletionPreview(id: string) {
    const plan=projectDeletionPlan(this.db,this.workspace(id),this.workspaces());
    return { sessions:plan.sessions.length,repositories:plan.repositories.length,sharedSessions:plan.sharedSessions,sharedRepositories:plan.sharedRepositories };
  }
  deleteWorkspace(id: string, version: unknown, cleanup?: () => void): void {
    this.db.transaction(() => {
      const workspace = this.workspace(id);
      if (version !== workspace.version)
        throw new LocalStateError("Workspace settings changed. Reload before deleting.", 409);
      assertDeletionIdle(this.db,workspace);
      cleanup?.();
      deleteProjectData(this.db, workspace, this.workspaces());
    }).immediate();
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
    return store.identity("client");
  } finally {
    store.close();
  }
}
