import type { CloudClient } from "./http/client.js";
import type { CloudTaskState } from "./tasks.js";

export interface CloudBlueprintTaskInput {
  title: string;
  keyPointsText?: string;
  moduleIds?: string[];
  modules?: string[];
  priority?: "high" | "medium" | "low";
  progressState?: CloudTaskState;
  estimatedPersonDays?: number | null;
  startAt?: string | null;
  dueAt?: string | null;
}
export interface CloudBlueprintInput {
  localProjectId: string;
  teamId?: string;
  scope?: "personal";
  clientRequestId?: string;
  title: string;
  baseIntent?: string;
  modules?: Array<{ name: string }>;
  tasks?: CloudBlueprintTaskInput[];
  attachments?: Array<{ displayName: string; contentText: string }>;
}
export interface CloudBlueprintUploaded {
  blueprint: {
    id: string;
    title: string;
    projectId: string | null;
    teamId: string | null;
    creationOrigin: "local";
  };
  tasks: Array<{ taskId: string; title: string; modules: Array<{ id: string; name: string }> }>;
  attachments: Array<{ id: string; displayName: string }>;
  reused: boolean;
}
export function uploadCloudBlueprint(
  client: CloudClient,
  input: CloudBlueprintInput,
): Promise<CloudBlueprintUploaded> {
  return client.post("/api/cli/blueprints", input);
}

export interface CloudBlueprintAttachment {
  id: string;
  displayName: string;
  parseStatus: string;
  parseError: string | null;
}
export function uploadCloudBlueprintAttachment(
  client: CloudClient,
  blueprintId: string,
  file: File,
): Promise<{ attachment: CloudBlueprintAttachment }> {
  const form = new FormData();
  form.set("file", file);
  return client.postForm(
    `/api/cli/blueprints/${encodeURIComponent(blueprintId)}/attachments`,
    form,
  );
}
export function listCloudBlueprints(
  client: CloudClient,
  query: URLSearchParams,
): Promise<{
  blueprints: Array<{
    id: string;
    title: string;
    projectId: string | null;
    teamId: string | null;
    userId: string;
    state: string;
  }>;
  total: number;
  nextOffset: number | null;
}> {
  return client.get(`/api/cli/blueprints?${query}`);
}
