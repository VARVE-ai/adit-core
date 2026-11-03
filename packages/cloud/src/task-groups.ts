import type { CloudClient } from "./http/client.js";
import type { CloudTaskTypeScope } from "./tasks.js";

export interface CloudTaskGroup {
  id: string;
  name: string;
  teamId: string | null;
  projectId: string | null;
  sortOrder: number;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  canManage: boolean;
  taskCount: number;
}
export interface CloudGroupTaskVersion {
  taskId: string;
  expectedUpdatedAt: string;
  groupId: string | null;
}
export interface CloudGroupTask extends CloudGroupTaskVersion {
  title: string;
  updatedAt: string;
  blueprintId: string | null;
  blueprintTitle: string | null;
  parentTaskId: string | null;
  groupName: string | null;
  progressState: string;
  assigneeId: string | null;
  canManage: boolean;
  canDelete: boolean;
}
export interface CloudTaskGroupList {
  scope: { teamId: string | null; projectId: string | null };
  groups: CloudTaskGroup[];
  canCreate: boolean;
}
export interface CloudTaskGroupDetail {
  scope: CloudTaskGroupList["scope"];
  group: CloudTaskGroup;
  tasks: CloudGroupTask[];
  total: number;
  nextOffset: number | null;
}
export interface CloudTaskGroupMutation {
  name?: string;
  expectedUpdatedAt: string;
  before?: string;
  after?: string;
  position?: "first" | "last";
}
function path(scope: CloudTaskTypeScope, resource?: string, offset?: number) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(scope)) if (value !== undefined) query.set(key, value);
  if (offset !== undefined) query.set("offset", String(offset));
  return `/api/cli/tasks/groups${resource ? "/" + encodeURIComponent(resource) : ""}?${query}`;
}
export function listCloudTaskGroups(
  client: CloudClient,
  scope: CloudTaskTypeScope,
): Promise<CloudTaskGroupList> {
  return client.get(path(scope));
}
export function showCloudTaskGroup(
  client: CloudClient,
  scope: CloudTaskTypeScope,
  id: string,
  offset = 0,
): Promise<CloudTaskGroupDetail> {
  return client.get(path(scope, id, offset));
}
export function createCloudTaskGroup(
  client: CloudClient,
  scope: CloudTaskTypeScope,
  name: string,
): Promise<{ group: CloudTaskGroup }> {
  return client.post(path(scope), { name });
}
export function updateCloudTaskGroup(
  client: CloudClient,
  scope: CloudTaskTypeScope,
  id: string,
  input: CloudTaskGroupMutation,
): Promise<{ group: CloudTaskGroup }> {
  return client.patch(path(scope, id), input);
}
export function deleteCloudTaskGroup(
  client: CloudClient,
  scope: CloudTaskTypeScope,
  id: string,
  expectedUpdatedAt: string,
): Promise<{ removed: boolean; groupId: string; affected: number }> {
  return client.delete(path(scope, id), { expectedUpdatedAt });
}
export function selectCloudGroupTasks(
  client: CloudClient,
  scope: CloudTaskTypeScope,
  taskIds: string[],
): Promise<{ tasks: CloudGroupTask[] }> {
  return client.post(path(scope, "selection"), { taskIds });
}
export function moveCloudGroupTasks(
  client: CloudClient,
  scope: CloudTaskTypeScope,
  targetGroupId: string | null,
  tasks: CloudGroupTaskVersion[],
): Promise<{
  changed: number;
  unchanged: number;
  targetGroupId: string | null;
  tasks: Array<{
    taskId: string;
    fromGroupId: string | null;
    groupId: string | null;
    updatedAt: string;
  }>;
}> {
  return client.post(path(scope, "membership"), { targetGroupId, tasks });
}
