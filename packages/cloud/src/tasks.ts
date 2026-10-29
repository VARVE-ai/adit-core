import type { CloudClient } from "./http/client.js";

export type CloudTaskState =
  "unassigned" | "not_started" | "in_progress" | "paused" | "done" | "accepted";
export interface CloudTask {
  taskType?: string | null;
  taskTypeColor?: string | null;
  taskId: string;
  title: string;
  keyPointsText: string | null;
  progressState: CloudTaskState;
  priority: string;
  dueAt: string | null;
  startAt?: string | null;
  estimatedPersonDays?: number | null;
  createdAt?: string | null;
  scope?: string[];
  updatedAt: string;
  /** Present on show, context and update; list rows are already the caller's own tasks. */
  assigneeId?: string | null;
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
  timeline?: CloudTaskTimeline;
  task: CloudTask;
  assignableMembers: Array<{ id: string; name: string | null; email: string | null }>;
  permissions: {
    canEditTaskType?: boolean;
    canManage: boolean;
    canUpdateState: boolean;
    canUpdateDueAt: boolean;
  };
}
export interface CloudTaskTimelineOptions {
  timelineLimit?: number;
  timelineCursor?: string;
}
export interface CloudTaskTimelineDifference {
  field: string;
  from: string | null;
  to: string | null;
}
export interface CloudTaskTimelineChange {
  id: string;
  title: string;
  kind: "task" | "module";
  taskType?: string | null;
  taskTypeColor?: string | null;
  reason?: string;
  hasProgress?: boolean;
  fields?: string[];
  details?: CloudTaskTimelineDifference[];
  contentChanges?: CloudTaskTimelineDifference[];
}
export interface CloudTaskTimelineEntry {
  id: string;
  kind: string;
  createdAt: string;
  actorId: string | null;
  actorName: string | null;
  runId: string | null;
  fieldLabels?: { from: string | null; to: string | null };
  changes: {
    added: CloudTaskTimelineChange[];
    updated: CloudTaskTimelineChange[];
    removed: CloudTaskTimelineChange[];
    restored?: CloudTaskTimelineChange[];
    field?: { name: string; from?: unknown; to?: unknown };
    colorFrom?: string | null;
    colorTo?: string | null;
    statusDecision?: { id: string; action: "update" | "confirm" | "revert"; source: string };
  } | null;
}
export interface CloudTaskTimeline {
  entries: CloudTaskTimelineEntry[];
  order: "newest_first";
  nextCursor: string | null;
}
export interface CloudTaskContext extends CloudTaskDetail {
  prd: {
    blueprintId: string;
    title: string;
    markdown: string | null;
    updatedAt: string;
    activeVersionId: string | null;
    latestVersionId: string | null;
  } | null;
  resources: Array<{
    id: string;
    name: string;
    kind: "attachment" | "material" | "sketch";
    mimeType: string | null;
    url: string | null;
    expiresAt: string | null;
  }>;
}
export interface CloudTaskPatch {
  taskType?: string | null;
  progressState?: Exclude<CloudTaskState, "unassigned">;
  dueAt?: string | null;
  startAt?: string | null;
  estimatedPersonDays?: number | null;
  createdAt?: string | null;
  scope?: string[];
  title?: string;
  keyPointsText?: string | null;
  priority?: "high" | "medium" | "low";
  assigneeId?: string | null;
}

export interface CloudTaskCreate extends Omit<CloudTaskPatch, "scope" | "title" | "keyPointsText"> {
  localProjectId: string;
  teamId?: string;
  scope?: "personal";
  title: string;
  keyPointsText: string;
  taskScope?: string[];
}

export interface CloudTaskCreated {
  project: CloudTaskList["project"];
  scope: CloudTaskList["scope"];
  task: CloudTask;
}

export interface CloudTaskAttachment {
  id: string;
  taskId: string;
  uploadedById: string;
  displayName: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
}

export function uploadCloudTaskAttachment(
  client: CloudClient,
  taskId: string,
  file: File,
): Promise<{ attachment: CloudTaskAttachment }> {
  const form = new FormData();
  form.set("file", file);
  return client.postForm(`/api/cli/tasks/${encodeURIComponent(taskId)}/attachments`, form);
}

export const uploadCloudTaskImage = uploadCloudTaskAttachment;

export async function createCloudTask(
  client: CloudClient,
  input: CloudTaskCreate,
): Promise<CloudTaskCreated> {
  const result = await client.post<CloudTaskCreated>("/api/cli/tasks", input);
  verifyTaskType(result.task, input.taskType, true);
  return result;
}

export function listCloudTasks(
  client: CloudClient,
  input: {
    localProjectId: string;
    teamId?: string;
    scope?: "personal";
    state?: string;
    taskType?: string;
    unclassified?: boolean;
    offset?: number;
    limit?: number;
  },
): Promise<CloudTaskList> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input))
    if (value !== undefined) params.set(key, String(value));
  return client.get(`/api/cli/tasks?${params}`);
}

function timelineQuery(options: CloudTaskTimelineOptions) {
  const params = new URLSearchParams();
  if (options.timelineLimit !== undefined) {
    if (
      !Number.isInteger(options.timelineLimit) ||
      options.timelineLimit < 1 ||
      options.timelineLimit > 100
    )
      throw new Error("Timeline limit must be between 1 and 100");
    params.set("timelineLimit", String(options.timelineLimit));
  }
  if (options.timelineCursor !== undefined) {
    if (!options.timelineCursor || options.timelineCursor.length > 512)
      throw new Error("Invalid task timeline cursor");
    params.set("timelineCursor", options.timelineCursor);
  }
  return params.size ? `?${params}` : "";
}

export function showCloudTask(
  client: CloudClient,
  taskId: string,
  options: CloudTaskTimelineOptions = {},
): Promise<CloudTaskDetail> {
  return client.get(`/api/cli/tasks/${encodeURIComponent(taskId)}${timelineQuery(options)}`);
}

export function cloudTaskContext(
  client: CloudClient,
  taskId: string,
  options: CloudTaskTimelineOptions = {},
): Promise<CloudTaskContext> {
  return client.get(
    `/api/cli/tasks/${encodeURIComponent(taskId)}/context${timelineQuery(options)}`,
  );
}

export async function updateCloudTask(
  client: CloudClient,
  taskId: string,
  patch: CloudTaskPatch,
  expectedUpdatedAt: string,
): Promise<{ task: CloudTask; recorded: string[] }> {
  const result = await client.patch<{ task: CloudTask; recorded: string[] }>(
    `/api/cli/tasks/${encodeURIComponent(taskId)}`,
    { patch, expectedUpdatedAt },
  );
  verifyTaskType(result.task, patch.taskType, false);
  return result;
}

export class CloudTaskTypeVerificationError extends Error {
  readonly code = "TASK_TYPE_NOT_SAVED";
  constructor(
    readonly taskId: string,
    readonly taskCreated: boolean,
  ) {
    super(
      `Cloud did not confirm the requested task type. Upgrade Cloud and inspect task ${taskId}; do not repeat task creation.`,
    );
  }
}

export function taskTypeNameKey(name: string): string {
  return name.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function verifyTaskType(task: CloudTask, requested: string | null | undefined, created: boolean) {
  if (requested === undefined) return;
  const matches =
    requested === null
      ? task.taskType === null && task.taskTypeColor === null
      : typeof task.taskType === "string" &&
        taskTypeNameKey(task.taskType) === taskTypeNameKey(requested) &&
        typeof task.taskTypeColor === "string" &&
        /^#[0-9a-f]{6}$/i.test(task.taskTypeColor);
  if (!matches) throw new CloudTaskTypeVerificationError(task.taskId, created);
}

export interface CloudTaskTypeScope {
  localProjectId: string;
  teamId?: string;
  scope?: "personal";
}
export interface CloudTaskTypeOption {
  id: string;
  name: string;
  color: string;
  updatedAt: string;
}
export interface CloudTaskTypes {
  scope: { teamId: string | null; projectId: string | null };
  options: CloudTaskTypeOption[];
  canManageTaskTypes: boolean;
}
export interface CloudTaskTypeMutation {
  name?: string;
  color?: string;
  expectedUpdatedAt: string;
}
function taskTypesPath(scope: CloudTaskTypeScope, id?: string) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(scope)) if (value !== undefined) params.set(key, value);
  return `/api/cli/tasks/types${id ? "/" + encodeURIComponent(id) : ""}?${params}`;
}
export function listCloudTaskTypes(
  client: CloudClient,
  scope: CloudTaskTypeScope,
): Promise<CloudTaskTypes> {
  return client.get(taskTypesPath(scope));
}
export function createCloudTaskType(
  client: CloudClient,
  scope: CloudTaskTypeScope,
  input: { name: string; color?: string },
): Promise<{ option: CloudTaskTypeOption }> {
  return client.post(taskTypesPath(scope), input);
}
export function updateCloudTaskType(
  client: CloudClient,
  scope: CloudTaskTypeScope,
  id: string,
  input: CloudTaskTypeMutation,
): Promise<{ option: CloudTaskTypeOption }> {
  return client.patch(taskTypesPath(scope, id), input);
}
export function deleteCloudTaskType(
  client: CloudClient,
  scope: CloudTaskTypeScope,
  id: string,
  expectedUpdatedAt: string,
): Promise<{ removed: boolean }> {
  return client.delete(taskTypesPath(scope, id), { expectedUpdatedAt });
}
