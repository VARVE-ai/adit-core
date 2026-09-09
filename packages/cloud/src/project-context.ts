/**
 * Cloud-facing local project context.
 *
 * Enriches the synchronous core config with Git remote data collected from
 * each repository before sync/link requests are sent.
 */

import { projectNameFromRoot, toRepositoryPayload, readProjectManifest, resolveManifestRepositories, resolveActiveManifestRepositories, deriveProjectType } from "@varveai/adit-core";
import type { AditConfig, LocalRepository, ProjectType } from "@varveai/adit-core";
import { getRemoteUrl } from "@varveai/adit-engine";
import { normalizeGitHubRepoKey } from "./project-link/repo-key.js";

export interface CloudRepository extends LocalRepository {
  repositoryUrl: string | null;
  canonicalRepoKey: string | null;
}

export interface CloudProjectContext {
  projectType: ProjectType;
  localProjectId: string;
  projectRoot: string;
  projectName: string;
  repositories: CloudRepository[];
  remoteUrl: string | null;
  canonicalRepoKey: string | null;
  registration?: {
    localProjectId: string;
    projectName: string;
    updatedAt: string;
    repositories: Array<ReturnType<typeof toRepositoryPayload> & { included: boolean }>;
  };
}

export async function resolveCloudProjectContext(config: AditConfig): Promise<CloudProjectContext> {
  const manifest = readProjectManifest(config.projectRoot);
  if (manifest && manifest.projectId !== config.projectId) {
    throw new Error("Project identity changed. Reload the project before syncing.");
  }
  const repositories = await Promise.all(
    (manifest ? resolveActiveManifestRepositories(config.projectRoot, manifest) : config.repositories).map(async (repo) => enrichRepository(repo)),
  );

  const projectType = manifest ? deriveProjectType(manifest) : config.projectType;
  const registration = manifest?.schemaVersion === 3 && !manifest.mergedIntoProjectId && !manifest.cloudDeletedAt
    ? {
      localProjectId: config.projectId,
      projectName: projectNameFromRoot(config.projectRoot),
      updatedAt: manifest.updatedAt,
      repositories: resolveManifestRepositories(config.projectRoot, manifest).map((repository, index) => {
        const entry = manifest.repositories[index];
        const active = repositories.find((r) => r.localRepositoryId === repository.localRepositoryId);
        return {
          ...toRepositoryPayload(active ?? { ...repository, repositoryUrl: entry.repositoryUrl ?? null }),
          included: entry.syncEnabled !== false && !entry.cloudDeletedAt,
        };
      }),
    }
    : undefined;

  return {
    projectType,
    localProjectId: config.projectId,
    projectRoot: config.projectRoot,
    projectName: projectNameFromRoot(config.projectRoot),
    repositories,
    // Kept for wire compatibility; Git identities live only in repositories.
    remoteUrl: null,
    canonicalRepoKey: null,
    ...(registration ? { registration } : {}),
  };
}

export function repositoryPayloads(repositories: CloudRepository[]): ReturnType<typeof toRepositoryPayload>[] {
  return repositories.map((repo) => toRepositoryPayload(repo));
}

async function enrichRepository(repository: LocalRepository): Promise<CloudRepository> {
  const repositoryUrl = await safeGetRemoteUrl(repository.path);
  return {
    ...repository,
    repositoryUrl,
    canonicalRepoKey: normalizeGitHubRepoKey(repositoryUrl),
  };
}

async function safeGetRemoteUrl(projectRoot: string): Promise<string | null> {
  try {
    return await getRemoteUrl(projectRoot);
  } catch {
    return null;
  }
}
