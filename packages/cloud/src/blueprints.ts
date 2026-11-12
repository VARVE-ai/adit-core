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
