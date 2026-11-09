import type { LocalStore } from "@varveai/adit-core";
import { CloudApiError, cloudProjectStateKey, type ProjectDeletionPolicy } from "@varveai/adit-cloud";

export const projectDeletedMessage = "Cloud project deleted. Uploads are paused; local records are retained. Restore the Cloud project in Settings to continue.";
export type CloudProjectPause = { policy: ProjectDeletionPolicy; revision: string };
export function pauseKey(serverUrl:string,accountId:string,workspaceId:string) {
  return `cloud-project-paused:${cloudProjectStateKey({serverUrl, accountId}, workspaceId)}`;
}
export function projectDeletionFromError(error: unknown, localProjectId: string): ProjectDeletionPolicy | null {
  if (!(error instanceof CloudApiError) || error.status !== 410) return null;
  const body = error.body as {code?:unknown;deletionPolicy?:ProjectDeletionPolicy} | undefined;
  const policy = body?.deletionPolicy;
  return body?.code === "PROJECT_DELETED" && policy?.projectDeleted === true && policy.localProjectId === localProjectId
    && typeof policy.deletionOperationId === "string" ? policy : null;
}
export function readPause(store:LocalStore,key:string) { return store.get<CloudProjectPause|null>(key,null); }
