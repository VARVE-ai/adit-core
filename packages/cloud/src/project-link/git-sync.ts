/** Incremental Git metadata sync used by the conversation sync cycle. */

import type Database from "better-sqlite3";
import type { CloudProjectContext, CloudRepository } from "../project-context.js";
import { repositoryPayloads } from "../project-context.js";
import type { CloudClient } from "../http/client.js";
import type { CommitUploadResponse, LinkInitResponse } from "./types.js";
import { getProjectLinkCache, updateCachedGitState } from "./cache.js";
import {
  branchHeadMap,
  collectBranches,
  collectCommitFileStats,
  collectCommitsBetweenRefSnapshots,
  collectDefaultBranch,
  collectGitIdentity,
  collectGitRefsFingerprint,
  resolveCommitBranches,
} from "./git-collector.js";

const COMMIT_BATCH_SIZE = 1000;
const COMMIT_FILE_STAT_LIMIT = 500;

export interface GitSyncFailure {
  repositoryId: string;
  relativePath: string;
  message: string;
}

export interface GitSyncResult {
  repositoriesChecked: number;
  repositoriesUpdated: number;
  repositoriesSkipped: number;
  branchesUploaded: number;
  commitsUploaded: number;
  failures: GitSyncFailure[];
}

/**
 * Upload Git metadata for repositories that were explicitly linked before.
 *
 * Ref heads are the cursor. The cursor is advanced only after both the branch
 * snapshot and every commit batch succeed, so a failed upload is retried by a
 * later conversation sync or a manual `adit cloud link`.
 */
export async function syncLinkedGitMetadata(
  db: Database.Database,
  client: CloudClient,
  context: CloudProjectContext,
  serverUrl: string,
): Promise<GitSyncResult> {
  const result: GitSyncResult = {
    repositoriesChecked: 0,
    repositoriesUpdated: 0,
    repositoriesSkipped: 0,
    branchesUploaded: 0,
    commitsUploaded: 0,
    failures: [],
  };

  for (const repository of context.repositories) {
    const cache = getProjectLinkCache(
      db,
      context.localProjectId,
      serverUrl,
      repository.localRepositoryId,
    );
    if (!cache?.confirmedProjectId) {
      result.repositoriesSkipped++;
      continue;
    }

    result.repositoriesChecked++;
    try {
      const fingerprint = await collectGitRefsFingerprint(repository.path);
      if (!fingerprint) {
        throw new Error("Unable to read local Git refs");
      }

      const branches = await collectBranches(repository.path);
      const currentHeads = branchHeadMap(branches);

      if (fingerprint === cache.gitRefsFingerprint) {
        // Older versions stored only the fingerprint. Seed the new ref-head
        // cursor without uploading data that was already confirmed.
        if (Object.keys(cache.gitRefHeads).length === 0) {
          updateCachedGitState(
            db,
            context.localProjectId,
            serverUrl,
            {
              refHeads: currentHeads,
              refsFingerprint: fingerprint,
            },
            repository.localRepositoryId,
          );
        }
        result.repositoriesSkipped++;
        continue;
      }

      const defaultBranch = await collectDefaultBranch(repository.path);
      const identity = await collectGitIdentity(repository.path);
      const commits = await collectCommitsBetweenRefSnapshots(
        repository.path,
        currentHeads,
        cache.gitRefHeads,
      );
      await resolveCommitBranches(repository.path, commits, branches, defaultBranch);
      await attachRecentFileStats(repository.path, commits);

      await uploadBranches(client, context, repository, branches, defaultBranch, identity);
      const accepted = await uploadCommits(
        client,
        context.localProjectId,
        repository,
        commits,
      );

      updateCachedGitState(
        db,
        context.localProjectId,
        serverUrl,
        {
          refHeads: currentHeads,
          refsFingerprint: fingerprint,
        },
        repository.localRepositoryId,
      );

      result.repositoriesUpdated++;
      result.branchesUploaded += branches.length;
      result.commitsUploaded += accepted;
    } catch (error) {
      result.failures.push({
        repositoryId: repository.localRepositoryId,
        relativePath: repository.relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

async function uploadBranches(
  client: CloudClient,
  context: CloudProjectContext,
  repository: CloudRepository,
  branches: Awaited<ReturnType<typeof collectBranches>>,
  defaultBranch: string | null,
  identity: Awaited<ReturnType<typeof collectGitIdentity>>,
): Promise<void> {
  const remoteUrl = repository.repositoryUrl?.trim();
  if (!remoteUrl) {
    throw new Error("No Git remote URL is available for the linked repository");
  }

  await client.post<LinkInitResponse>("/api/project-link/init", {
    localProjectId: context.localProjectId,
    projectType: context.projectType,
    localRepositoryId: repository.localRepositoryId,
    relativePath: repository.relativePath,
    displayName: repository.displayName,
    remoteUrl,
    repositoryUrl: remoteUrl,
    canonicalRepoKey: repository.canonicalRepoKey,
    repositories: repositoryPayloads(context.repositories),
    defaultBranch,
    gitAuthorName: identity.authorName,
    gitAuthorEmail: identity.authorEmail,
    branches: branches.map((branch) => ({
      name: branch.name,
      headSha: branch.headSha,
    })),
  });
}

async function uploadCommits(
  client: CloudClient,
  localProjectId: string,
  repository: CloudRepository,
  commits: Awaited<ReturnType<typeof collectCommitsBetweenRefSnapshots>>,
): Promise<number> {
  let accepted = 0;
  for (let index = 0; index < commits.length; index += COMMIT_BATCH_SIZE) {
    const batch = commits.slice(index, index + COMMIT_BATCH_SIZE);
    const response = await client.post<CommitUploadResponse>(
      "/api/project-link/commits",
      {
        localProjectId,
        localRepositoryId: repository.localRepositoryId,
        relativePath: repository.relativePath,
        sinceCommitSha: null,
        commits: batch,
      },
    );
    accepted += response.accepted;
  }
  return accepted;
}

async function attachRecentFileStats(
  projectRoot: string,
  commits: Awaited<ReturnType<typeof collectCommitsBetweenRefSnapshots>>,
): Promise<void> {
  const shas = commits.slice(0, COMMIT_FILE_STAT_LIMIT).map((commit) => commit.sha);
  if (shas.length === 0) return;

  const bySha = await collectCommitFileStats(projectRoot, shas);
  for (const commit of commits) {
    const files = bySha.get(commit.sha);
    if (files && files.length > 0) commit.files = files;
  }
}
