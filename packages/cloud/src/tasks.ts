import type { CloudClient } from "./http/client.js";

export type CloudTaskState = "not_started" | "in_progress" | "done";
export interface CloudTask {
  taskId: string;
  title: string;
  keyPointsText: string | null;
  progressState: CloudTaskState;
  priority: string;
  dueAt: string | null;
  updatedAt: string;
  assigneeId: string | null;
  blueprintId: string | null;
  blueprintTitle?: string | null;
  projectId: string | null;
  teamId: string | null;
}
export interface CloudTaskList {
  project: { id: string; localProjectId: string; name: string | null };
  scope: { projectId: string | null; teamId: string | null; teamName: string | null };
  tasks: CloudTask[];
  total: number;
  nextOffset: number | null;
}
export interface CloudTaskDetail {
  task: CloudTask;
  assignableMembers: Array<{ id: string; name: string | null; email: string | null }>;
  permissions: { canManage: boolean; canUpdateState: boolean; canUpdateDueAt: boolean };
}
export interface CloudTaskContext extends CloudTaskDetail {
  prd: { blueprintId: string; title: string; markdown: string | null; updatedAt: string; activeVersionId: string | null; latestVersionId: string | null } | null;
  resources: Array<{ id: string; name: string; kind: "attachment" | "material" | "sketch"; mimeType: string | null; url: string | null; expiresAt: string | null }>;
}
export interface CloudTaskPatch {
  progressState?: CloudTaskState;
  dueAt?: string | null;
  title?: string;
  keyPointsText?: string;
  priority?: "high" | "medium" | "low";
  assigneeId?: string;
}

export function listCloudTasks(client: CloudClient, input: { localProjectId: string; teamId?: string; scope?: "personal"; state?: string; offset?: number; limit?: number }): Promise<CloudTaskList> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined) params.set(key, String(value));
  return client.get(`/api/cli/tasks?${params}`);
}

export function showCloudTask(client: CloudClient, taskId: string): Promise<CloudTaskDetail> {
  return client.get(`/api/cli/tasks/${encodeURIComponent(taskId)}`);
}

export function cloudTaskContext(client: CloudClient, taskId: string): Promise<CloudTaskContext> {
  return client.get(`/api/cli/tasks/${encodeURIComponent(taskId)}/context`);
}

export function updateCloudTask(client: CloudClient, taskId: string, patch: CloudTaskPatch, expectedUpdatedAt: string): Promise<{ task: CloudTask; recorded: string[]; warnings: string[] }> {
  return client.patch(`/api/cli/tasks/${encodeURIComponent(taskId)}`, { patch, expectedUpdatedAt });
}
