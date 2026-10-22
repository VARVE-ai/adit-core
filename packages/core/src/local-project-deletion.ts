import type Database from "better-sqlite3";
import type { LocalWorkspace } from "./local-state.js";
import { LocalStateError } from "./local-state.js";
import { containsPath, pathKey } from "./local-projects.js";

type Session = { provider: string; id: string; cwd: string; parent_id: string | null };
const sessionKey = (s: {provider:string;id:string}) => `${s.provider}\0${s.id}`;
function tables(db: Database.Database) {
  return new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(r => r.name));
}

/** Uses identity/location ownership, including deselected sources and relocated history. */
export function projectDeletionPlan(db: Database.Database, workspace: LocalWorkspace, workspaces: LocalWorkspace[]) {
  const present = tables(db);
  const sessions = present.has("adit_history_sessions") ? db.prepare(`SELECT s.provider,s.id,s.parent_id,
    coalesce(nullif(s.cwd,''),a.workspace,'') cwd FROM adit_history_sessions s
    LEFT JOIN adit_history_assignments a ON a.provider=s.provider AND a.session_id=s.id`).all() as Session[] : [];
  const links = db.prepare("SELECT workspace_id,provider,session_id,original_root FROM adit_local_project_sessions").all() as {workspace_id:string;provider:string;session_id:string;original_root:string}[];
  const locations = db.prepare("SELECT workspace_id,path FROM adit_local_repository_locations").all() as {workspace_id:string;path:string}[];
  const ownership = new Map<string, Set<string>>();
  const roots = (w: LocalWorkspace) => [...new Set([w.path, ...links.filter(l => l.workspace_id===w.id).map(l => l.original_root)])];
  for (const w of workspaces) {
    const explicit = new Set(links.filter(l => l.workspace_id===w.id).map(l => `${l.provider}\0${l.session_id}`));
    const selected = new Set(sessions.filter(s => explicit.has(sessionKey(s)) || (s.cwd && roots(w).some(root => containsPath(root,s.cwd)))).map(sessionKey));
    // Child transcripts can omit cwd; retain the parent's project ownership.
    for (let changed=true;changed;) {
      changed=false;
      for (const s of sessions) if (s.parent_id && selected.has(`${s.provider}\0${s.parent_id}`) && !selected.has(sessionKey(s))) { selected.add(sessionKey(s)); changed=true; }
    }
    ownership.set(w.id,selected);
  }
  const candidates = sessions.filter(s => ownership.get(workspace.id)?.has(sessionKey(s)));
  const exclusive = candidates.filter(s => !workspaces.some(w => w.id!==workspace.id && ownership.get(w.id)?.has(sessionKey(s))));
  const repoPaths = new Set<string>([...workspace.repositories, ...locations.filter(l => l.workspace_id===workspace.id).map(l => l.path)]);
  for (const r of db.prepare("SELECT path FROM adit_local_repositories UNION SELECT repository path FROM adit_local_commits").all() as {path:string}[])
    if (roots(workspace).some(root => containsPath(root,r.path))) repoPaths.add(r.path);
  const sharedRepositories = [...repoPaths].filter(path => workspaces.some(w => w.id!==workspace.id &&
    (roots(w).some(root => containsPath(root,path)) || w.repositories.some(r => pathKey(r)===pathKey(path)) || locations.some(l => l.workspace_id===w.id && pathKey(l.path)===pathKey(path)))));
  return { sessions:exclusive, repositories:[...repoPaths].filter(p => !sharedRepositories.includes(p)), sharedSessions:candidates.length-exclusive.length, sharedRepositories:sharedRepositories.length, roots:roots(workspace) };
}

export function assertDeletionIdle(db: Database.Database, workspace: LocalWorkspace) {
  const present = tables(db);
  if (db.prepare("SELECT 1 FROM adit_local_jobs WHERE json_extract(data,'$.workspaceId') IN (?,?) AND json_extract(data,'$.status') IN ('queued','running') LIMIT 1").get(workspace.id,workspace.path))
    throw new LocalStateError("Wait for this project's background tasks to finish before deleting it.",409);
  for (const table of ["adit_attribution_runs","adit_history_secret_scan_runs","adit_pr_description_jobs","adit_achievement_evaluations","adit_shares"])
    if (present.has(table) && db.prepare(`SELECT 1 FROM ${table} WHERE workspace_id=? AND status IN ('queued','running','indexing','publishing') LIMIT 1`).get(workspace.id))
      throw new LocalStateError("Wait for this project's background tasks to finish before deleting it.",409);
}

/** Called inside LocalStore's immediate transaction. Never contacts remote services. */
export function deleteProjectData(db: Database.Database, workspace: LocalWorkspace, workspaces: LocalWorkspace[]) {
  assertDeletionIdle(db,workspace);
  const present=tables(db), plan=projectDeletionPlan(db,workspace,workspaces);
  const remove=(table:string,where:string,...values:unknown[]) => {
    if (present.has(table)) db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...values);
  };
  // Immutable publications deliberately do not cascade from collected history.
  for (const table of ["adit_share_turns","adit_share_redactions","adit_share_commits","adit_share_publish_attempts"])
    remove(table,"version_id IN (SELECT v.id FROM adit_share_versions v JOIN adit_shares s ON s.id=v.share_id WHERE s.workspace_id=?)",workspace.id);
  remove("adit_share_versions","share_id IN (SELECT id FROM adit_shares WHERE workspace_id=?)",workspace.id);
  for (const table of ["adit_pr_description_commits","adit_pr_description_sessions","adit_pr_description_commit_sessions","adit_pr_description_usage","adit_pr_description_models","adit_pr_description_share_links","adit_pr_description_prompts"])
    remove(table,"description_id IN (SELECT id FROM adit_pr_descriptions WHERE workspace_id=?)",workspace.id);
  for (const table of ["adit_local_cloud_sessions","adit_local_cloud_receipts"])
    remove(table,"scope IN (SELECT id FROM adit_local_cloud_scopes WHERE workspace_id=?)",workspace.id);

  for (const s of plan.sessions) {
    remove("adit_history_secret_dispositions","finding_id IN (SELECT id FROM adit_history_secret_findings WHERE provider=? AND session_id=?)",s.provider,s.id);
    // Foreign-key cascades remove messages, blocks, FTS entries, turns, usage,
    // source references, edit overrides, findings and command evidence.
    remove("adit_history_sessions","provider=? AND id=?",s.provider,s.id);
  }
  const deleted = new Set(plan.sessions.map(sessionKey));
  if (present.has("adit_history_file_checkpoints")) for (const row of db.prepare("SELECT provider,path,scope,sessions_json FROM adit_history_file_checkpoints").all() as {provider:string;path:string;scope:string;sessions_json:string}[]) {
    const refs=JSON.parse(row.sessions_json) as [string,string][];
    const [,covered]=JSON.parse(row.scope) as [string,string[]];
    if(refs.some(([p,id])=>deleted.has(`${p}\0${id}`)) || covered.some(path=>plan.roots.some(root=>pathKey(path)===pathKey(root))))
      remove("adit_history_file_checkpoints","provider=? AND path=? AND scope=?",row.provider,row.path,row.scope);
  }
  if (present.has("adit_history_discovery_cache")) for (const row of db.prepare("SELECT provider,path,scope,metadata_json FROM adit_history_discovery_cache").all() as {provider:string;path:string;scope:string;metadata_json:string}[]) {
    // Invalidate an affected shared metadata file instead of deleting its source.
    const metadata=JSON.parse(row.metadata_json) as {sessions?:{id:string;cwd?:string}[]};
    const [,scopeRoot]=JSON.parse(row.scope) as [string,string];
    if ((scopeRoot && plan.roots.some(root=>pathKey(scopeRoot)===pathKey(root))) || metadata.sessions?.some(s=>deleted.has(`${row.provider}\0${s.id}`)))
      remove("adit_history_discovery_cache","provider=? AND path=? AND scope=?",row.provider,row.path,row.scope);
  }
  for (const path of plan.repositories) for (const table of ["adit_local_commit_files","adit_local_commit_parents","adit_local_commits","adit_local_git_checkpoints","adit_local_repositories"])
    remove(table,`${table==="adit_local_repositories"?"path":"repository"}=? COLLATE NOCASE`,path);
  for (const table of ["adit_shares","adit_pr_descriptions","adit_pr_description_jobs","adit_attribution_runs","adit_history_secret_scan_runs","adit_achievement_evaluations","adit_achievement_progress","adit_achievement_unlocks","adit_achievement_evidence","adit_achievement_preferences","adit_achievement_export_items","adit_local_cloud_scopes"])
    remove(table,"workspace_id=?",workspace.id);
  for (const row of db.prepare("SELECT key,data FROM adit_local_settings").all() as {key:string;data:string}[]) {
    if ((row.key.startsWith("cloud-job:") && row.key.endsWith(`:${workspace.id}`)) ||
      plan.roots.some(root=>row.key===`repository-info:${process.platform==="win32"?root.toLowerCase():root}`)) remove("adit_local_settings","key=?",row.key);
  }
  remove("adit_local_jobs","json_extract(data,'$.workspaceId') IN (?,?)",workspace.id,workspace.path);
  remove("adit_local_workspaces","id=?",workspace.id);
  return { sharedSessions:plan.sharedSessions, sharedRepositories:plan.sharedRepositories };
}
