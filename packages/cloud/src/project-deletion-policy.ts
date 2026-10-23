import { LocalStore, resolveLocalProject, type ProjectManifest } from "@varveai/adit-core";
import type { CloudClient } from "./http/client.js";
import { CloudApiError } from "./http/errors.js";

export interface DeletedRepositoryPolicy {
  deletionOperationId: string;
  localRepositoryId: string;
  relativePath: string;
  deletedAt: string;
}

export interface ProjectDeletionPolicy {
  localProjectId: string;
  projectDeleted: boolean;
  deletionOperationId: string | null;
  deletedAt: string | null;
  deletedRepositories: DeletedRepositoryPolicy[];
}

interface ProjectDeletionPolicyResponse {
  deletionPolicy: ProjectDeletionPolicy;
}

export class CloudProjectDeletedError extends Error {
  constructor(public readonly deletedAt: string | null) {
    super(
      "This project identity was deleted from ADIT Cloud. Review the project in Settings before linking again.",
    );
    this.name = "CloudProjectDeletedError";
  }
}

export async function refreshProjectDeletionPolicy(
  client: CloudClient,
  projectRoot: string,
  localProjectId: string,
): Promise<ProjectDeletionPolicy | null> {
  let response: ProjectDeletionPolicyResponse;
  try {
    response = await client.get<ProjectDeletionPolicyResponse>(
      `/api/project-deletions?localProjectId=${encodeURIComponent(localProjectId)}`,
    );
  } catch (error) {
    // Keep the CLI compatible with Cloud deployments that predate deletion logs.
    if (error instanceof CloudApiError && error.status === 404) return null;
    throw error;
  }

  await applyProjectDeletionPolicy(projectRoot, response.deletionPolicy);
  return response.deletionPolicy;
}

export async function applyProjectDeletionPolicy(
  projectRoot: string,
  policy: ProjectDeletionPolicy,
): Promise<ProjectManifest> {
  const project=resolveLocalProject({path:projectRoot});
  if(project.projectId!==policy.localProjectId)throw new Error("Cloud deletion policy does not match the registered project.");
  const store=new LocalStore();
  try{return store.db.transaction(()=>{
    const w=store.workspace(project.projectId);
    const repositoryPolicies={...w.repositoryPolicies};
    for(const deleted of policy.deletedRepositories) {
      const identity=store.db.prepare("SELECT repository_id FROM adit_local_project_repositories WHERE workspace_id=? AND relative_path=?").get(w.id,deleted.relativePath) as {repository_id:string}|undefined;
      if(identity?.repository_id!==deleted.localRepositoryId)continue;
      repositoryPolicies[deleted.relativePath]={...repositoryPolicies[deleted.relativePath],cloudDeletedAt:deleted.deletedAt,cloudDeletionOperationId:deleted.deletionOperationId};
    }
    const deletedAt=w.cloudDeletedAt??(policy.projectDeleted?policy.deletedAt??new Date().toISOString():undefined);
    if(JSON.stringify(repositoryPolicies)!==JSON.stringify(w.repositoryPolicies??{})||deletedAt!==w.cloudDeletedAt){
      store.db.prepare("UPDATE adit_local_workspaces SET data=? WHERE id=?").run(JSON.stringify({...w,repositoryPolicies,cloudDeletedAt:deletedAt,version:w.version+1,updatedAt:new Date().toISOString()}),w.id);
    }
    return {schemaVersion:3,projectId:w.id,createdAt:w.updatedAt,updatedAt:w.updatedAt,cloudDeletedAt:deletedAt,
      repositories:project.repositories.map(r=>({relativePath:r.relativePath,repositoryId:r.localRepositoryId,...repositoryPolicies[r.relativePath]}))} as ProjectManifest;
  }).immediate();}finally{store.close();}
}
