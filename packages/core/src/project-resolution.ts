import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { dirname, join, resolve } from "node:path";
import { LocalStateError, canonicalDirectory, localDataDir, type LocalWorkspace } from "./local-state.js";
import { containsPath, directoryAvailable, directoryUnavailable, pathKey, projectRepositories } from "./local-projects.js";
import { findProjectManifestRoot, findRegisteringParent, readProjectManifest, resolveActiveManifestRepositories, type LocalRepository } from "./config/project.js";

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
  const path = canonicalDirectory(options.path ?? process.env.ADIT_PROJECT_ROOT ?? process.cwd());
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
      if (!directoryAvailable(w.path)) throw new LocalStateError(directoryUnavailable,409);
      if (!containsPath(w.path,path)) throw new LocalStateError("The directory is outside the selected project",409);
      const manifest = readProjectManifest(w.path);
      if (manifest && manifest.projectId !== w.id) throw new LocalStateError("Project identity conflicts with the registered workspace",409);
      result = { projectId:w.id,projectRoot:w.path,repositories:projectRepositories(db!,w),source:"registry",cloudDeletedAt:manifest?.cloudDeletedAt ?? null };
    } else {
      if (options.workspaceId) throw new LocalStateError("Workspace not found",404);
      let gitRoot: string | undefined;
      for (let dir=path;;dir=dirname(dir)) {
        if (existsSync(join(dir,".git"))) { gitRoot=dir;break; }
        if (dirname(dir)===dir) break;
      }
      const own = gitRoot ? readProjectManifest(gitRoot) : null;
      const root = gitRoot ? (own && !own.mergedIntoProjectId ? gitRoot : findRegisteringParent(gitRoot)?.root ?? gitRoot) : findProjectManifestRoot(path);
      const manifest = root ? readProjectManifest(root) : null;
      if (!root || !manifest || manifest.mergedIntoProjectId) throw new LocalStateError("Project not found. Add its working directory in Settings.",404);
      const registered = workspaces.find(w => w.id === manifest.projectId);
      if (registered && pathKey(registered.path) !== pathKey(root)) throw new LocalStateError(directoryUnavailable,409);
      result = {projectId:manifest.projectId,projectRoot:resolve(root),repositories:resolveActiveManifestRepositories(root,manifest),source:"manifest",cloudDeletedAt:manifest.cloudDeletedAt ?? null};
    }
    const repos = result.repositories.filter(r => containsPath(r.path,path)).sort((a,b)=>b.path.length-a.path.length);
    result.repository = repos[0];
    if (options.requireRepository && (!result.repository || !directoryAvailable(result.repository.path) || !existsSync(join(result.repository.path,".git"))))
      throw new LocalStateError("Select a registered Git repository inside this project",409);
    return result;
  } finally { db?.close(); }
}
