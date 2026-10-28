import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { join, resolve } from "node:path";
import { LocalStateError, localDataDir, type LocalWorkspace } from "./local-state.js";
import { containsPath, directoryAvailable, projectRepositories } from "./local-projects.js";
import { type LocalRepository } from "./config/project.js";

export interface ResolvedLocalProject {
  projectId: string;
  projectRoot: string;
  repositories: LocalRepository[];
  repository?: LocalRepository;
  source: "registry" | "manifest";
  cloudDeletedAt: string | null;
}
/** Shared, read-only identification. It neither collects nor creates a Cloud project. */
export function resolveLocalProject(options: { path?: string; workspaceId?: string; directory?: string; requireRepository?: boolean } = {}): ResolvedLocalProject {
  const path = resolve(options.path ?? process.cwd());
  const directory = options.directory ?? localDataDir();
  let db: Database.Database | undefined;
  try {
    if (existsSync(join(directory,"local.sqlite"))) db = new Database(join(directory,"local.sqlite"),{readonly:true,fileMustExist:true});
    const workspaces: LocalWorkspace[] = db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adit_local_workspaces'").get()
      ? (db.prepare("SELECT data FROM adit_local_workspaces").all() as {data:string}[]).map(row=>JSON.parse(row.data)) : [];
    const candidates = workspaces.filter(w => options.workspaceId ? w.id === options.workspaceId : containsPath(w.path,path));
    if (candidates.length > 1) throw new LocalStateError("This directory belongs to multiple projects. Choose an explicit workspace in Settings.",409);
    let result: ResolvedLocalProject;
    if (candidates.length === 1) {
      const w = candidates[0];
      if (!containsPath(w.path,path)) throw new LocalStateError("The directory is outside the selected project",409);
      result = { projectId:w.id,projectRoot:w.path,repositories:projectRepositories(db!,w),source:"registry",cloudDeletedAt:w.cloudDeletedAt ?? null };
    } else {
      throw new LocalStateError("Project not found. Run adit init or add its working directory in Settings.",404);
    }
    const repos = result.repositories.filter(r => containsPath(r.path,path)).sort((a,b)=>b.path.length-a.path.length);
    result.repository = repos[0];
    if (options.requireRepository && (!result.repository || !directoryAvailable(result.repository.path) || !existsSync(join(result.repository.path,".git"))))
      throw new LocalStateError("Select a registered Git repository inside this project",409);
    return result;
  } finally { db?.close(); }
}

export function projectRuntimeDirectory(projectId: string, directory = localDataDir()): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(projectId)) throw new LocalStateError("Invalid project identity");
  return join(directory, "runtime", projectId);
}
