import type Database from "better-sqlite3";
import { statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { computeLocalRepositoryId, generateRepositoryId, resolveManifestRepositories, type LocalRepository, type ProjectManifest } from "./config/project.js";
import { LocalStateError, type LocalWorkspace } from "./local-state.js";
import { ATTRIBUTION_RESULT_TABLES } from "./local-history/attribution-schema.js";

export const directoryUnavailable = "Workspace directory is unavailable. Update its path in Settings.";
export function directoryAvailable(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
export function pathKey(path: string): string {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}
export function containsPath(root: string, path: string): boolean {
  const value = relative(pathKey(root), pathKey(path));
  return !value || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}
export function relocatedRepositories(old: LocalWorkspace, root: string, selected: string[] = old.repositories): string[] {
  return selected.map(path => old.repositories.some(p => pathKey(p) === pathKey(path)) && pathKey(root) !== pathKey(old.path)
    ? resolve(root, relative(old.path, path)) : path);
}

export function createProjectRegistry(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS adit_local_project_repositories (
      workspace_id TEXT NOT NULL REFERENCES adit_local_workspaces(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL, repository_id TEXT NOT NULL,
      PRIMARY KEY(workspace_id,relative_path)
    );
    CREATE TABLE IF NOT EXISTS adit_local_project_sessions (
      workspace_id TEXT NOT NULL REFERENCES adit_local_workspaces(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, session_id TEXT NOT NULL, original_root TEXT NOT NULL, relative_cwd TEXT NOT NULL,
      PRIMARY KEY(workspace_id,provider,session_id)
    );
    CREATE TABLE IF NOT EXISTS adit_local_repository_locations (
      workspace_id TEXT NOT NULL REFERENCES adit_local_workspaces(id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL, path TEXT NOT NULL,
      PRIMARY KEY(workspace_id,path)
    );
  `);
}
export function projectRepositories(db: Database.Database, workspace: LocalWorkspace): LocalRepository[] {
  const rows = db.prepare("SELECT relative_path,repository_id FROM adit_local_project_repositories WHERE workspace_id=?").all(workspace.id) as {relative_path:string;repository_id:string}[];
  return workspace.repositories.map(path => {
    const rel = relative(workspace.path, path).replaceAll("\\", "/") || ".";
    const row = rows.find(r => r.relative_path === rel);
    if (!row) throw new LocalStateError("Project repository identity is missing. Save the workspace in Settings.", 409);
    return { localRepositoryId: row.repository_id, relativePath: rel, path, displayName: basename(path), repositoryUrl: null, canonicalRepoKey: null };
  });
}

/** Cloud exclusions never hide locally collected history. */
export function projectUploadRepositories(db: Database.Database, workspace: LocalWorkspace): LocalRepository[] {
  if (workspace.cloudDeletedAt) return [];
  return projectRepositories(db,workspace).filter(r => {
    const policy=workspace.repositoryPolicies?.[r.relativePath];
    return !policy?.cloudDeletedAt && policy?.syncEnabled !== false;
  });
}
export function saveProjectRepositories(db: Database.Database, workspace: LocalWorkspace, manifest: ProjectManifest | null, legacyIdentity = false): void {
  const legacy = manifest ? resolveManifestRepositories(workspace.path, manifest) : [];
  const find = db.prepare("SELECT repository_id FROM adit_local_project_repositories WHERE workspace_id=? AND relative_path=?");
  const insert = db.prepare("INSERT INTO adit_local_project_repositories VALUES (?,?,?)");
  // Keep identities for unselected repositories as well, so toggling a selection cannot mint a new identity.
  const paths = new Set([...workspace.repositories, ...legacy.map(r => r.path)]);
  for (const path of paths) {
    const rel = relative(workspace.path, path).replaceAll("\\", "/") || ".";
    const old = find.get(workspace.id, rel) as {repository_id:string} | undefined;
    const original = legacy.find(r => pathKey(r.path) === pathKey(path));
    if (old && original && old.repository_id !== original.localRepositoryId)
      throw new LocalStateError("Repository identity conflicts with the registered project", 409);
    const identity = old?.repository_id ?? original?.localRepositoryId ?? (rel === "." ? workspace.id : legacyIdentity ? computeLocalRepositoryId(workspace.id,rel) : generateRepositoryId());
    if (!old) insert.run(workspace.id, rel, identity);
    db.prepare("INSERT INTO adit_local_repository_locations VALUES (?,?,?) ON CONFLICT DO NOTHING").run(workspace.id,identity,pathKey(path));
  }
}

export function projectSessionLocations(db: Database.Database, workspace: LocalWorkspace) {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adit_local_project_sessions'").get();
  const rows = has ? db.prepare("SELECT provider,session_id,original_root,relative_cwd FROM adit_local_project_sessions WHERE workspace_id=?").all(workspace.id) as {provider:string;session_id:string;original_root:string;relative_cwd:string}[] : [];
  return new Map(rows.map(row => [`${row.provider}\0${row.session_id}`, row]));
}

/** Retain already collected facts when the user explicitly changes the directory. Never scan the old path. */
export function relocateProjectHistory(db: Database.Database, old: LocalWorkspace, next: LocalWorkspace): void {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(r => r.name));
  if (tables.has("adit_history_sessions")) {
    const sessions = db.prepare(`SELECT s.provider,s.id,coalesce(nullif(s.cwd,''),a.workspace,'') cwd
      FROM adit_history_sessions s LEFT JOIN adit_history_assignments a ON a.provider=s.provider AND a.session_id=s.id`).all() as {provider:string;id:string;cwd:string}[];
    const save = db.prepare("INSERT INTO adit_local_project_sessions VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING");
    for (const s of sessions) if (s.cwd && containsPath(old.path,s.cwd))
      save.run(old.id,s.provider,s.id,old.path,relative(old.path,s.cwd));
  }
  for (const from of old.repositories) {
    const to = resolve(next.path,relative(old.path,from));
    if (!next.repositories.some(p => pathKey(p) === pathKey(to)) || pathKey(from) === pathKey(to)) continue;
    // A target with its own collected repository must not be silently merged.
    const identity=db.prepare("SELECT repository_id FROM adit_local_project_repositories WHERE workspace_id=? AND relative_path=?").get(old.id,relative(old.path,from).replaceAll("\\","/") || ".") as {repository_id:string}|undefined;
    const previousLocation=db.prepare("SELECT repository_id FROM adit_local_repository_locations WHERE workspace_id=? AND path=?").get(old.id,pathKey(to)) as {repository_id:string}|undefined;
    if (db.prepare("SELECT 1 FROM adit_local_commits WHERE repository=? LIMIT 1").get(to) && (!identity || previousLocation?.repository_id !== identity.repository_id))
      throw new LocalStateError("The target repository already has collected history. Choose its existing workspace.",409);
    // Shared/overlapping workspaces can still browse their old paths; preserve those rows.
    for (const table of ["adit_local_commits","adit_local_commit_parents","adit_local_commit_files","adit_local_git_checkpoints","adit_local_repositories"]) {
      const column = table === "adit_local_repositories" ? "path" : "repository";
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(c => c.name);
      db.prepare(`INSERT OR IGNORE INTO ${table} SELECT ${columns.map(c => c === column ? "?" : `"${c}"`).join(",")} FROM ${table} WHERE ${column}=?`).run(to,from);
    }
    for (const table of ATTRIBUTION_RESULT_TABLES.map(name => `adit_attribution_${name}`)) if (tables.has(table))
      db.prepare(`UPDATE ${table} SET repository=? WHERE repository=? AND run_id IN (SELECT id FROM adit_attribution_runs WHERE workspace_id=?)`).run(to,from,old.id);
    for (const table of ["adit_pr_descriptions","adit_achievement_evidence"]) if (tables.has(table))
      db.prepare(`UPDATE ${table} SET repository=? WHERE repository=? AND workspace_id=?`).run(to,from,old.id);
    if(tables.has("adit_pr_description_commits")) db.prepare(`UPDATE adit_pr_description_commits SET repository=? WHERE repository=? AND description_id IN (SELECT id FROM adit_pr_descriptions WHERE workspace_id=?)`).run(to,from,old.id);
  }
}

export function assertProjectIdle(db: Database.Database, id: string): void {
  if (db.prepare("SELECT 1 FROM adit_local_jobs WHERE json_extract(data,'$.workspaceId')=? AND json_extract(data,'$.status') IN ('queued','running') LIMIT 1").get(id))
    throw new LocalStateError("Wait for this workspace's organization to finish before changing its directory.",409);
  for (const table of ["adit_attribution_runs", "adit_history_secret_scan_runs", "adit_pr_description_jobs", "adit_achievement_evaluations"]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    if (db.prepare(`SELECT 1 FROM ${table} WHERE workspace_id=? AND status IN ('queued','running') LIMIT 1`).get(id))
      throw new LocalStateError("Wait for this workspace's background tasks to finish before changing its directory.",409);
  }
}
