/**
 * Cloud-facing local project context.
 *
 * Enriches the synchronous core config with Git remote data collected from
 * each repository before sync/link requests are sent.
 */

import { projectNameFromRoot, toRepositoryPayload } from "@varveai/adit-core";
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
}

export async function resolveCloudProjectContext(config: AditConfig): Promise<CloudProjectContext> {
  const repositories = await Promise.all(
    config.repositories.map(async (repo) => enrichRepository(repo)),
  );

  const primaryRepository = repositories.find((repo) => repo.relativePath === ".") ?? repositories[0] ?? null;
  const remoteUrl = config.projectType === "repo" ? primaryRepository?.repositoryUrl ?? null : null;
  const canonicalRepoKey =
    config.projectType === "repo" ? primaryRepository?.canonicalRepoKey ?? null : null;

  return {
    projectType: config.projectType,
    localProjectId: config.projectId,
    projectRoot: config.projectRoot,
    projectName: projectNameFromRoot(config.projectRoot),
    repositories,
    remoteUrl,
    canonicalRepoKey,
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
