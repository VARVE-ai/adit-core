import type { CloudClient } from "./http/client.js";
import type { CloudTaskTypeScope } from "./tasks.js";

export interface CloudTaskModule {
  id: string;
  name: string;
  updatedAt: string;
  canManage: boolean;
  taskCount: number;
}
export interface CloudTaskModuleList {
  scope: { projectId: string | null; teamId: string | null };
  modules: CloudTaskModule[];
}
export interface CloudTaskModuleMembership extends CloudTaskModuleList {
  moduleIds: string[];
  updatedAt: string;
  canEdit: boolean;
}
function modulePath(scope: CloudTaskTypeScope, id?: string) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(scope)) if (value !== undefined) query.set(key, value);
  return `/api/cli/tasks/modules${id ? `/${encodeURIComponent(id)}` : ""}?${query}`;
}
export function listCloudTaskModules(
  client: CloudClient,
  scope: CloudTaskTypeScope,
): Promise<CloudTaskModuleList> {
  return client.get(modulePath(scope));
}
export function createCloudTaskModule(
  client: CloudClient,
  scope: CloudTaskTypeScope,
  name: string,
): Promise<{ module: CloudTaskModule }> {
  return client.post(modulePath(scope), { name });
}
export function updateCloudTaskModule(
  client: CloudClient,
  scope: CloudTaskTypeScope,
  id: string,
  name: string,
  expectedUpdatedAt: string,
): Promise<{ module: CloudTaskModule }> {
  return client.patch(modulePath(scope, id), { name, expectedUpdatedAt });
}
export function deleteCloudTaskModule(
  client: CloudClient,
  scope: CloudTaskTypeScope,
  id: string,
  expectedUpdatedAt: string,
): Promise<{ removed: boolean }> {
  return client.delete(modulePath(scope, id), { expectedUpdatedAt });
}
export function readCloudTaskModules(
  client: CloudClient,
  taskId: string,
): Promise<CloudTaskModuleMembership> {
  return client.get(`/api/cli/tasks/${encodeURIComponent(taskId)}/modules`);
}
export function setCloudTaskModules(
  client: CloudClient,
  taskId: string,
  moduleIds: string[],
  expectedUpdatedAt: string,
): Promise<CloudTaskModuleMembership> {
  return client.patch(`/api/cli/tasks/${encodeURIComponent(taskId)}/modules`, {
    moduleIds,
    expectedUpdatedAt,
  });
}
