import type { CloudClient } from "./http/client.js";

export interface CloudProjectDocumentUploadInput {
  /** Personal workspace project ID. Omit for an explicit team-view upload. */
  projectId?: string;
  scope?: "team" | "personal";
  teamId?: string;
  fileName: string;
  content: string;
  sourcePath?: string;
  displayName?: string;
  replaceDocId?: string;
  folderId?: string;
}

export interface CloudProjectDocumentUploadResult {
  projectDocument: Record<string, unknown>;
  status: "created" | "new_version" | "unchanged" | string;
  versionNumber?: number;
  existingDocId?: string;
  existingDisplayName?: string;
  suggestedName?: string;
  message?: string;
}

/** Upload a Markdown document to the selected Cloud project or team library. */
export function uploadCloudProjectDocument(
  client: CloudClient,
  input: CloudProjectDocumentUploadInput,
): Promise<CloudProjectDocumentUploadResult> {
  const { projectId: localProjectId, ...body } = input;
  return client.post("/api/cli/project-documents", { ...body, localProjectId });
}
