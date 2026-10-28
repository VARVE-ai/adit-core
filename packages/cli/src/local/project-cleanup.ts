import Database from "better-sqlite3";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { LocalStateError, type LocalStore, type LocalWorkspace } from "@varveai/adit-core";

function assertManagedPath(root: string, target: string) {
  const base=resolve(root), absolute=resolve(target), rel=relative(base,absolute);
  if (!rel || rel===".." || rel.startsWith(`..${process.platform==="win32"?"\\":"/"}`) || isAbsolute(rel)) throw new LocalStateError("Unsafe project cleanup path",409);
  // Compare relative paths, which already handles Windows drive/path casing.
  // Reject junctions at the root as well as descendants before opening/deleting.
  if(lstatSync(base).isSymbolicLink() || relative(realpathSync(base),base)) throw new LocalStateError("Project cleanup cannot follow symbolic links",409);
  for(let current=absolute;relative(base,current)!=="";current=dirname(current)) {
    if(existsSync(current) && lstatSync(current).isSymbolicLink()) throw new LocalStateError("Project cleanup cannot follow symbolic links",409);
    if(dirname(current)===current) throw new LocalStateError("Unsafe project cleanup path",409);
  }
}

/** Only known ADIT artifacts. Identity manifests and native Agent logs stay intact. */
export function cleanupProjectFiles(store: LocalStore, workspace: LocalWorkspace) {
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(workspace.id)) throw new LocalStateError("Invalid workspace identity");
  const runtime=join(store.directory,"runtime",workspace.id);
  assertManagedPath(store.directory,runtime);
  const legacy=join(workspace.path,".adit","adit.sqlite");
  if(existsSync(legacy)) {
    assertManagedPath(workspace.path,legacy);
    const db=new Database(legacy,{fileMustExist:true,timeout:1000});
    try {
      const has=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
      const columns=(name:string)=>(db.prepare(`PRAGMA table_info(${name})`).all() as {name:string}[]).map(r=>r.name);
      db.pragma("foreign_keys=ON");
      db.transaction(()=>{
        if(has("sessions")) {
          const ids=db.prepare("SELECT id FROM sessions WHERE project_id=?").all(workspace.id) as {id:string}[];
          if(ids.length && has("sync_state") && columns("sync_state").includes("last_synced_event_id"))
            db.prepare("DELETE FROM sync_state WHERE last_synced_event_id IN (SELECT e.id FROM events e JOIN sessions s ON s.id=e.session_id WHERE s.project_id=?)").run(workspace.id);
          for(const {id} of ids) {
            if(has("events")) {
              db.prepare("UPDATE events SET parent_event_id=NULL WHERE parent_event_id IN (SELECT id FROM events WHERE session_id=?)").run(id);
              if(has("diffs"))db.prepare("DELETE FROM diffs WHERE event_id IN (SELECT id FROM events WHERE session_id=?)").run(id);
            }
            for(const table of ["session_platform_aliases","session_repo_heads","token_usage_records","token_usage_cursors","events","env_snapshots"])
              if(has(table) && columns(table).includes("session_id"))db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(id);
            db.prepare("DELETE FROM sessions WHERE id=?").run(id);
          }
          if(ids.length && !db.prepare("SELECT 1 FROM sessions LIMIT 1").get() && has("sync_state"))db.prepare("DELETE FROM sync_state").run();
        }
        for(const table of ["project_link_cache","sync_state"])
          if(has(table)&&columns(table).includes("project_id"))db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(workspace.id);
      }).immediate();
    } finally { db.close(); }
  }
  // Failure leaves the workspace registered, so cleanup can be safely retried.
  if(existsSync(runtime))rmSync(runtime,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
