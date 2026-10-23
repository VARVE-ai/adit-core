/**
 * Cloud-facing local project context.
 *
 * Enriches the synchronous core config with Git remote data collected from
 * each repository before sync/link requests are sent.
 */

import { toRepositoryPayload, LocalStore, loadConfig, projectUploadRepositories } from "@varveai/adit-core";
import { join } from "node:path";
import type { AditConfig, LocalRepository, ProjectType } from "@varveai/adit-core";
import { getRemoteUrl } from "@varveai/adit-engine";
import { normalizeGitHubRepoKey } from "./project-link/repo-key.js";

export interface CloudRepository extends LocalRepository {
  repositoryUrl: string | null;
  canonicalRepoKey: string | null;
}

export interface CloudProjectContext {
  projectType: ProjectType;
  localProjectId: string;
  projectRoot: string;
  projectName: string;
  repositories: CloudRepository[];
  remoteUrl: string | null;
  canonicalRepoKey: string | null;
  registration?: {
    localProjectId: string;
    projectName: string;
    updatedAt: string;
    repositories: Array<ReturnType<typeof toRepositoryPayload> & { included: boolean }>;
  };
}

export async function resolveCloudProjectContext(config: AditConfig): Promise<CloudProjectContext> {
  const current=loadConfig(config.projectRoot);
  if(current.projectId!==config.projectId)throw new Error("Project identity changed. Reload before linking.");
  const store=new LocalStore();
  try{
    const workspace=store.workspace(current.projectId);
    const selected=projectUploadRepositories(store.db,workspace);
    const repositories=await Promise.all(selected.map(enrichRepository));
    const entries=store.db.prepare("SELECT relative_path,repository_id FROM adit_local_project_repositories WHERE workspace_id=?").all(workspace.id) as {relative_path:string;repository_id:string}[];
    return {projectType:current.projectType,localProjectId:workspace.id,projectRoot:workspace.path,projectName:workspace.name,
      repositories,remoteUrl:null,canonicalRepoKey:null,
      registration:{localProjectId:workspace.id,projectName:workspace.name,updatedAt:workspace.updatedAt,repositories:entries.map(entry=>{
        const found=repositories.find(r=>r.localRepositoryId===entry.repository_id);
        return {...toRepositoryPayload(found??{localRepositoryId:entry.repository_id,relativePath:entry.relative_path,path:join(workspace.path,entry.relative_path),displayName:entry.relative_path,repositoryUrl:null,canonicalRepoKey:null}),included:!!found};
      })}};
  }finally{store.close();}
}

export function repositoryPayloads(repositories: CloudRepository[]): ReturnType<typeof toRepositoryPayload>[] {
  return repositories.map((repo) => toRepositoryPayload(repo));
}

async function enrichRepository(repository: LocalRepository): Promise<CloudRepository> {
  const repositoryUrl = await safeGetRemoteUrl(repository.path);
  return {
    ...repository,
    repositoryUrl,
    canonicalRepoKey: normalizeGitHubRepoKey(repositoryUrl),
  };
}

async function safeGetRemoteUrl(projectRoot: string): Promise<string | null> {
  try {
    return await getRemoteUrl(projectRoot);
  } catch {
    return null;
  }
}
