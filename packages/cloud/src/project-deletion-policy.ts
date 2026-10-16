import {
  computeLocalRepositoryId,
  isRootRepositoryPath,
  readProjectManifest,
  withProjectInitLock,
  writeProjectManifest,
  type ProjectManifest,
  type ProjectManifestRepository,
} from "@varveai/adit-core";
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
      "This project identity was deleted from ADIT Cloud. Run 'adit init' to create a new project identity before linking again.",
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
  return withProjectInitLock(projectRoot, async () => {
    const manifest = readProjectManifest(projectRoot);
    if (!manifest) {
      throw new Error("Project manifest does not exist.");
    }
    if (manifest.projectId !== policy.localProjectId) {
      throw new Error("Cloud deletion policy does not match the local project manifest.");
    }

    let changed = false;
    const repositories = manifest.repositories.map((entry) => {
      const deletion = findRepositoryDeletion(manifest, entry, policy.deletedRepositories);
      if (!deletion || entry.cloudDeletedAt) return entry;
      changed = true;
      return {
        ...entry,
        cloudDeletedAt: deletion.deletedAt,
        cloudDeletionOperationId: deletion.deletionOperationId,
      };
    });

    const nextProjectDeletedAt = manifest.cloudDeletedAt ?? (
      policy.projectDeleted ? policy.deletedAt ?? new Date().toISOString() : undefined
    );
    const nextOperationId = manifest.cloudDeletionOperationId ?? (
      policy.projectDeleted ? policy.deletionOperationId ?? undefined : undefined
    );
    if (
      nextProjectDeletedAt !== manifest.cloudDeletedAt ||
      nextOperationId !== manifest.cloudDeletionOperationId
    ) {
      changed = true;
    }
    if (!changed) return manifest;

    const next: ProjectManifest = {
      ...manifest,
      repositories,
      ...(nextProjectDeletedAt ? { cloudDeletedAt: nextProjectDeletedAt } : {}),
      ...(nextOperationId ? { cloudDeletionOperationId: nextOperationId } : {}),
      updatedAt: new Date().toISOString(),
    };
    writeProjectManifest(projectRoot, next);
    return next;
  });
}

function findRepositoryDeletion(
  manifest: ProjectManifest,
  entry: ProjectManifestRepository,
  deletions: DeletedRepositoryPolicy[],
): DeletedRepositoryPolicy | undefined {
  const localRepositoryId = isRootRepositoryPath(entry.relativePath)
    ? manifest.projectId
    : entry.repositoryId ?? computeLocalRepositoryId(manifest.projectId, entry.relativePath);
  return deletions.find((deletion) => deletion.localRepositoryId === localRepositoryId);
}
