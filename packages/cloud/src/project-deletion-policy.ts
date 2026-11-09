import { LocalStore, resolveLocalProject, normalizeServerUrl, type ProjectManifest, type LocalWorkspace } from "@varveai/adit-core";
import { createHash, randomUUID } from "node:crypto";
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
  serverProjectId?: string;
  accountId?: string;
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

  const target = client.deletionTarget;
  if (target) {
    if (response.deletionPolicy.localProjectId !== localProjectId) throw new Error("Cloud deletion policy does not match the project.");
    const store = new LocalStore(target.directory);
    try { saveTargetDeletionPolicy(store, target, response.deletionPolicy); } finally { store.close(); }
  } else await applyProjectDeletionPolicy(projectRoot, response.deletionPolicy);
  return response.deletionPolicy;
}

export type CloudDeletionTarget = { serverUrl: string; accountId: string };
export function cloudProjectStateKey(target: CloudDeletionTarget, workspaceId: string) {
  return createHash("sha256").update(JSON.stringify([normalizeServerUrl(target.serverUrl), target.accountId, workspaceId])).digest("hex");
}
export function targetDeletionPolicy(store: LocalStore, target: CloudDeletionTarget, workspaceId: string) {
  return store.get<ProjectDeletionPolicy | null>(`cloud-project-policy:${cloudProjectStateKey(target, workspaceId)}`, null);
}
export function saveTargetDeletionPolicy(store: LocalStore, target: CloudDeletionTarget, policy: ProjectDeletionPolicy) {
  const key = cloudProjectStateKey(target, policy.localProjectId);
  store.set(`cloud-project-policy:${key}`, policy);
  // A normal lookup can pause uploads, but only explicit restoration may clear a pause.
  if (policy.projectDeleted) store.set(`cloud-project-paused:${key}`, { policy, revision: randomUUID() });
}
/** Target policy is an upload-only projection; collection and local identity are unchanged. */
export function workspaceForCloudTarget(store: LocalStore, workspace: LocalWorkspace, target: CloudDeletionTarget): LocalWorkspace {
  const policy = targetDeletionPolicy(store, target, workspace.id);
  if (!policy) return workspace;
  const repositoryPolicies: NonNullable<LocalWorkspace["repositoryPolicies"]> = {};
  for (const [path, value] of Object.entries(workspace.repositoryPolicies ?? {})) repositoryPolicies[path] = { syncEnabled: value.syncEnabled };
  const entries = store.db.prepare("SELECT relative_path, repository_id FROM adit_local_project_repositories WHERE workspace_id=?").all(workspace.id) as Array<{ relative_path: string; repository_id: string }>;
  for (const deleted of policy.deletedRepositories) {
    const entry = entries.find(row => row.repository_id === deleted.localRepositoryId);
    if (entry) repositoryPolicies[entry.relative_path] = { ...repositoryPolicies[entry.relative_path], cloudDeletedAt: deleted.deletedAt, cloudDeletionOperationId: deleted.deletionOperationId };
  }
  return { ...workspace, cloudDeletedAt: policy.projectDeleted ? policy.deletedAt ?? "deleted" : undefined, repositoryPolicies };
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
