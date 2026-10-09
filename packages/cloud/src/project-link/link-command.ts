/**
 * Project link command handler — orchestrates the 6-step link flow.
 *
 * Steps:
 *   1. Check credentials (handled by caller)
 *   2. Negotiate project ID with server
 *   3. Upload git metadata (branches + commits)
 *   4. Discover project documents
 *   5. Upload documents (with user confirmation in interactive mode)
 *   6. Quality check (and optional AI summary generation)
 */

import type Database from "better-sqlite3";
import { loadConfig } from "@varveai/adit-core";
import type { ProjectType } from "@varveai/adit-core";
import type { CloudClient } from "../http/client.js";
import { CloudApiError } from "../http/errors.js";
import type { CloudRepository } from "../project-context.js";
import { repositoryPayloads, resolveCloudProjectContext } from "../project-context.js";
import {
  CloudProjectDeletedError,
  refreshProjectDeletionPolicy,
} from "../project-deletion-policy.js";
import type {
  GitCommit,
  LinkOptions,
  LinkResult,
  StepTiming,
  NegotiateResponse,
  LinkInitResponse,
  CommitUploadResponse,
  DocumentUploadResponse,
  DiscoveredDocument,
  WorkspaceRepositoryFailure,
  WorkspaceRepositoryResult,
} from "./types.js";
import {
  collectDefaultBranch,
  collectGitIdentity,
  collectBranches,
  collectRemoteBranchSnapshot,
  collectCommitLogs,
  collectCommitCount,
  collectCommitFileStats,
  branchHeadMap,
  collectGitRefsFingerprint,
  resolveCommitBranches,
  projectNameFromRemoteUrl,
} from "./git-collector.js";
import { discoverDocuments, loadDocSettings } from "./doc-discovery.js";
import {
  getProjectLinkCache,
  upsertProjectLinkCache,
  clearProjectLinkCache,
  updateCachedDocHashes,
} from "./cache.js";
import { normalizeGitHubRepoKey } from "./repo-key.js";

/** Maximum number of commits per upload batch */
const COMMIT_BATCH_SIZE = 1000;

/**
 * Only the newest commits get changed-file lists attached. File lists
 * feed cloud-side content attribution, which only matters for recent
 * commits; skipping deep history keeps first-link sync fast and small.
 */
const COMMIT_FILE_STAT_LIMIT = 500;

/** Minimum staleness before re-uploading branches (1 hour) */
const BRANCH_STALE_MS = 60 * 60 * 1000;

type WorkspaceCommitDedupeState = Set<string>;

interface LinkRepositoryInternalOptions {
  silent?: boolean;
}

interface WorkspaceLinkFailure extends WorkspaceRepositoryFailure {
  error: unknown;
}

class LinkStepError extends Error {
  readonly step: string;
  readonly cause: unknown;

  constructor(step: string, cause: unknown) {
    super(errorMessage(cause));
    this.name = "LinkStepError";
    this.step = step;
    this.cause = cause;
  }
}

export class WorkspaceLinkPartialFailureError extends Error {
  readonly result: LinkResult;
  readonly repositoryResults: WorkspaceRepositoryResult[];
  readonly repositoryFailures: WorkspaceRepositoryFailure[];

  constructor(
    result: LinkResult,
    repositoryResults: WorkspaceRepositoryResult[],
    repositoryFailures: WorkspaceRepositoryFailure[],
  ) {
    super("Project link completed with repository failures.");
    this.name = "WorkspaceLinkPartialFailureError";
    this.result = result;
    this.repositoryResults = repositoryResults;
    this.repositoryFailures = repositoryFailures;
  }
}

function cloudDocumentSourcePath(repository: CloudRepository, sourcePath: string): string {
  return repository.relativePath === "." ? sourcePath : `${repository.relativePath}/${sourcePath}`;
}

function filterWorkspaceDuplicateCommits(
  commits: GitCommit[],
  workspaceCommitDedupeState?: WorkspaceCommitDedupeState,
): GitCommit[] {
  if (!workspaceCommitDedupeState) return commits;
  return commits.filter((commit) => !workspaceCommitDedupeState.has(commit.sha));
}

function rememberWorkspaceCommits(
  commits: GitCommit[],
  workspaceCommitDedupeState?: WorkspaceCommitDedupeState,
): void {
  if (!workspaceCommitDedupeState) return;
  for (const commit of commits) {
    workspaceCommitDedupeState.add(commit.sha);
  }
}

async function linkWorkspaceProject(
  db: Database.Database,
  client: CloudClient,
  repositories: CloudRepository[],
  projectId: string,
  projectType: ProjectType,
  projectName: string,
  serverUrl: string,
  options: LinkOptions,
): Promise<LinkResult> {
  const results: LinkResult[] = [];
  const failures: WorkspaceLinkFailure[] = [];
  const repositorySet = repositoryPayloads(repositories);
  const commitDedupeState: WorkspaceCommitDedupeState = new Set();
  const totalStart = performance.now();
  const log = options.json || options.silent ? (() => {}) : console.log.bind(console);

  log("");
  log("Project link");
  log(`Project:      ${projectName}`);
  log(`Server:       ${serverUrl}`);
  log(`Repositories: ${repositories.length}`);

  for (let index = 0; index < repositories.length; index++) {
    const repository = repositories[index];
    if (!repository) continue;

    logWorkspaceRepositoryStart(index + 1, repositories.length, repository, log);
    options.onRepositoryStart?.({ index: index + 1, total: repositories.length, relativePath: repository.relativePath });

    try {
      const result = await linkRepositoryCommand(
        db,
        client,
        repository,
        projectId,
        projectType,
        projectName,
        repositorySet,
        serverUrl,
        options,
        commitDedupeState,
        { silent: true },
      );
      results.push(result);
      logWorkspaceRepositoryResult(index + 1, repositories.length, result, log);
      options.onRepositoryDone?.({ index: index + 1, total: repositories.length, result: toWorkspaceRepositoryResult(result) });
    } catch (error) {
      const failure: WorkspaceLinkFailure = {
        localRepositoryId: repository.localRepositoryId,
        relativePath: repository.relativePath,
        step: errorStep(error),
        message: formatFailureMessage(error),
        status: errorStatus(error),
        response: errorResponse(error),
        error,
      };
      failures.push(failure);
      logWorkspaceRepositoryFailure(index + 1, repositories.length, failure, log);
      const { error: _error, ...reported } = failure;
      void _error;
      options.onRepositoryDone?.({ index: index + 1, total: repositories.length, failure: reported });
    }
  }

  const totalDurationMs = Math.round(performance.now() - totalStart);
  const result = createWorkspaceLinkResult(
    results,
    failures,
    projectId,
    projectName,
    serverUrl,
    totalDurationMs,
  );

  // Per-repository links run silent, so surface the same-remote notice from
  // negotiate here — it only ever appears on the negotiate that created the
  // project, and the user must see it in multi-repo mode too.
  const similarProjects = results.flatMap((repoResult) => repoResult.similarProjects ?? []);
  if (similarProjects.length > 0) {
    result.similarProjects = similarProjects;
    log("");
    log("Note: your cloud account already has projects pointing at the same git remote:");
    for (const similar of similarProjects) {
      const lastActive = similar.lastActivityAt ? ` (last active ${similar.lastActivityAt.slice(0, 10)})` : "";
      log(`  - ${similar.name || "(unnamed project)"}${lastActive}`);
    }
    log("This link created a NEW project; nothing was merged. If those are leftovers from another machine, delete them on the cloud settings page.");
  }

  logWorkspaceSummary(result, failures, log);

  if (failures.length > 0) {
    throw new WorkspaceLinkPartialFailureError(
      result,
      result.repositoryResults ?? [],
      result.repositoryFailures ?? [],
    );
  }

  return result;
}

/**
 * Execute the project link flow.
 *
 * The caller is responsible for:
 * - Loading credentials and verifying authentication
 * - Creating the CloudClient with a valid server URL
 * - Opening the database
 *
 * Returns a LinkResult summarizing what was done.
 */
export async function linkCommand(
  db: Database.Database,
  client: CloudClient,
  projectRoot: string,
  projectId: string,
  serverUrl: string,
  options: LinkOptions = {},
): Promise<LinkResult> {
  if (!options.dryRun && !options.deletionPolicyRefreshed) {
    await refreshProjectDeletionPolicy(client, projectRoot, projectId);
  }
  const projectConfig = loadConfig(projectRoot);
  if (projectConfig.cloudDeletedAt) {
    throw new CloudProjectDeletedError(projectConfig.cloudDeletedAt);
  }
  const projectContext = await resolveCloudProjectContext(projectConfig);
  const registration = !options.dryRun && projectContext.registration
    ? await client.post<{ projectId: string }>("/api/project-link/registration", projectContext.registration)
    : null;

  if (projectContext.projectType === "workspace" || projectContext.repositories.length === 0) {
    const result = await linkWorkspaceProject(
      db,
      client,
      projectContext.repositories,
      projectId,
      projectContext.projectType,
      projectContext.projectName,
      serverUrl,
      options,
    );
    if (projectContext.repositories.length === 0 && registration?.projectId) {
      return { ...result, projectId: registration.projectId, serverProjectId: registration.projectId };
    }
    return result;
  }

  const repository = projectContext.repositories[0];
  if (!repository) {
    throw new Error("No Git repositories found for project link.");
  }
  options.onRepositoryStart?.({ index: 1, total: 1, relativePath: repository.relativePath });
  const result = await linkRepositoryCommand(
    db,
    client,
    repository,
    projectId,
    projectContext.projectType,
    projectContext.projectName,
    repositoryPayloads(projectContext.repositories),
    serverUrl,
    options,
  );
  options.onRepositoryDone?.({ index: 1, total: 1, result: toWorkspaceRepositoryResult(result) });
  return result;
}

async function linkRepositoryCommand(
  db: Database.Database,
  client: CloudClient,
  repository: CloudRepository,
  projectId: string,
  projectType: ProjectType,
  projectName: string,
  repositories: ReturnType<typeof repositoryPayloads>,
  serverUrl: string,
  options: LinkOptions,
  workspaceCommitDedupeState?: WorkspaceCommitDedupeState,
  internalOptions: LinkRepositoryInternalOptions = {},
): Promise<LinkResult> {
  // In JSON or silent mode, suppress progress output
  const log = options.json || options.silent || internalOptions.silent
    ? (() => {})
    : console.log.bind(console);
  const shouldWrapStepErrors = internalOptions.silent === true || options.silent === true;
  const runStep = <T>(step: string, operation: () => Promise<T>): Promise<T> =>
    runLinkStep(step, operation, shouldWrapStepErrors);
  const runStepSync = <T>(step: string, operation: () => T): T =>
    runLinkStepSync(step, operation, shouldWrapStepErrors);
  const failStep = (step: string, cause: unknown): never => {
    if (shouldWrapStepErrors) throw new LinkStepError(step, cause);
    throw cause instanceof Error ? cause : new Error(String(cause));
  };
  const projectRoot = repository.path;
  const repositoryId = repository.localRepositoryId;
  let currentStep = "Prepare repository";

  // Step timing tracker
  const totalStart = performance.now();
  const stepTimings: StepTiming[] = [];

  function startStep(): number {
    return performance.now();
  }

  function endStep(stepName: string, stepStart: number): void {
    const entry = { step: stepName, durationMs: Math.round(performance.now() - stepStart) };
    stepTimings.push(entry);
    options.onStepComplete?.(entry);
  }

  // Handle --force: clear local cache and server data
  if (options.force && !options.dryRun) {
    log("Clearing cached link data...");
    clearProjectLinkCache(db, projectId, serverUrl, repositoryId);
    try {
      const params = new URLSearchParams({
        localProjectId: projectId,
        localRepositoryId: repositoryId,
        relativePath: repository.relativePath,
      });
      await client.delete(`/api/project-link/reset?${params.toString()}`);
      log("Server link data cleared.");
    } catch {
      // Server reset may fail if no link exists yet — that's fine
    }
  }

  // Load or initialize cache
  let cache = getProjectLinkCache(db, projectId, serverUrl, repositoryId);
  if (options.dryRun) cache = options.force ? null : cache ? structuredClone(cache) : null;

  // ──────────────────────────────────────────────────────────
  // Step 2: Negotiate project ID
  // ──────────────────────────────────────────────────────────

  currentStep = "Negotiate project ID";
  log(options.dryRun ? "\n[Step 1/4] Previewing local project (no server registration)..." : "\n[Step 1/4] Negotiating project ID with server...");
  const step1Start = startStep();

  const remoteUrl = repository.repositoryUrl?.trim() ?? "";
  if (!remoteUrl) {
    failStep(currentStep, new Error(`No git remote 'origin' configured for ${repository.relativePath}.`));
  }
  const canonicalRepoKey = repository.canonicalRepoKey ?? normalizeGitHubRepoKey(remoteUrl);
  const remoteProjectName = projectNameFromRemoteUrl(remoteUrl);
  const cloudProjectName = projectName;
  const repositoryDisplayName = repository.displayName || remoteProjectName;
  const cachedServerProjectId = cache?.confirmedProjectId ?? null;

  const negotiate: NegotiateResponse = options.dryRun
    ? { localProjectId: projectId, serverProjectId: cachedServerProjectId ?? projectId,
      confirmedProjectId: cachedServerProjectId ?? projectId, projectName: cloudProjectName,
      status: "confirmed", message: "Local preview; no server registration performed" }
    : await runStep(currentStep, () =>
    client.post<NegotiateResponse>(
      "/api/project-link/negotiate",
      {
        localProjectId: projectId,
        projectType,
        localRepositoryId: repositoryId,
        relativePath: repository.relativePath,
        displayName: repositoryDisplayName,
        remoteUrl,
        repositoryUrl: remoteUrl,
        canonicalRepoKey,
        repositories,
        projectName: cloudProjectName,
      },
    )
  );
  const confirmedProjectId = negotiate.confirmedProjectId;
  const serverProjectChanged =
    cachedServerProjectId !== null && cachedServerProjectId !== confirmedProjectId;

  if (negotiate.status === "id_mismatch") {
    log(`  Server found existing project with different ID. Adopting: ${confirmedProjectId}`);
  }

  log(`  Project ${options.dryRun ? "preview" : "confirmed"}: ${negotiate.projectName} (${confirmedProjectId.slice(0, 12)}...)`);

  if (negotiate.similarProjects && negotiate.similarProjects.length > 0) {
    log("  Note: your cloud account already has projects pointing at the same git remote:");
    for (const similar of negotiate.similarProjects) {
      const lastActive = similar.lastActivityAt ? ` (last active ${similar.lastActivityAt.slice(0, 10)})` : "";
      log(`    - ${similar.name || "(unnamed project)"}${lastActive}`);
    }
    log("  This link created a NEW project; nothing was merged. If those are leftovers from another machine, delete them on the cloud settings page.");
  }

  // Initialize or update cache. The cache key remains the local project ID;
  // confirmedProjectId is only the latest server ID seen for this login.
  const now = new Date().toISOString();
  if (!cache) {
    cache = {
      projectId,
      repositoryId,
      serverUrl,
      confirmedProjectId,
      gitRefHeads: {},
      gitRefsFingerprint: null,
      remoteRefsFingerprint: null,
      lastRemoteBranchCheckAt: null,
      lastBranchSyncAt: null,
      lastDocSyncAt: null,
      docHashes: {},
      initializedAt: now,
      updatedAt: now,
    };
    if (!options.dryRun) upsertProjectLinkCache(db, cache);
  } else {
    cache.confirmedProjectId = confirmedProjectId;
    if (serverProjectChanged) {
      log("  Server project changed for this login; resetting cached sync markers.");
      cache.gitRefHeads = {};
      cache.gitRefsFingerprint = null;
      cache.remoteRefsFingerprint = null;
      cache.lastRemoteBranchCheckAt = null;
      cache.lastBranchSyncAt = null;
      cache.lastDocSyncAt = null;
      cache.docHashes = {};
    }
    cache.updatedAt = now;
    if (!options.dryRun) upsertProjectLinkCache(db, cache);
  }

  // Keep using the client-local ID for API requests. The server resolves it
  // with the authenticated user to the cloud project ID.
  const localProjectId = projectId;
  const serverProjectId = confirmedProjectId;
  endStep("Negotiate project ID", step1Start);

  // ──────────────────────────────────────────────────────────
  // Step 3: Upload git metadata (branches + commits)
  // ──────────────────────────────────────────────────────────

  currentStep = "Collect git metadata";
  log("\n[Step 2/4] Uploading git metadata...");
  const step2Start = startStep();

  // 3a. Branches — collect once and reuse for commit branch resolution.
  // A refs fingerprint change bypasses the time-based cooldown so branch
  // creations/deletions reach the server snapshot without waiting it out.
  const currentRefsFingerprint = await runStep(currentStep, () => collectGitRefsFingerprint(projectRoot));
  const refsChanged = Boolean(currentRefsFingerprint) &&
    currentRefsFingerprint !== cache.gitRefsFingerprint;
  const allBranches = await runStep(currentStep, () => collectBranches(projectRoot));
  let remoteSnapshot: Awaited<ReturnType<typeof collectRemoteBranchSnapshot>> | null = null;
  try {
    remoteSnapshot = await collectRemoteBranchSnapshot(projectRoot);
  } catch (error) {
    log(`  Warning: ${error instanceof Error ? error.message : String(error)}`);
    log("  Keeping the last successful remote branch snapshot.");
  }
  const remoteRefsChanged = remoteSnapshot !== null &&
    remoteSnapshot.fingerprint !== cache.remoteRefsFingerprint;
  const branchesStale = !cache.lastBranchSyncAt ||
    (Date.now() - new Date(cache.lastBranchSyncAt).getTime() > BRANCH_STALE_MS) ||
    refsChanged ||
    remoteRefsChanged ||
    options.force;

  const defaultBranch = await runStep(currentStep, () => collectDefaultBranch(projectRoot));
  const gitIdentity = await runStep(currentStep, () => collectGitIdentity(projectRoot));
  let branchCount = 0;

  if (branchesStale) {
    if (options.dryRun) {
      log(`  [dry-run] Would upload ${allBranches.length} branches, default: ${defaultBranch ?? "unknown"}`);
      branchCount = allBranches.length;
    } else {
      currentStep = "Upload branches";
      const initResponse = await runStep(currentStep, () =>
        client.post<LinkInitResponse>(
          "/api/project-link/init",
          {
            localProjectId,
            projectType,
            localRepositoryId: repositoryId,
            relativePath: repository.relativePath,
            displayName: repositoryDisplayName,
            remoteUrl,
            repositoryUrl: remoteUrl,
            canonicalRepoKey,
            repositories,
            defaultBranch,
            gitAuthorName: gitIdentity.authorName,
            gitAuthorEmail: gitIdentity.authorEmail,
            branches: allBranches.map((b) => ({
              name: b.name,
              headSha: b.headSha,
            })),
            ...(remoteSnapshot ? {
              remoteBranchSnapshot: {
                branches: remoteSnapshot.branches.map((branch) => ({
                  name: branch.name,
                  headSha: branch.headSha,
                })),
              },
            } : {}),
          },
        )
      );
      branchCount = initResponse.projectLink.branchCount;
      cache.lastBranchSyncAt = new Date().toISOString();
      if (remoteSnapshot) {
        cache.remoteRefsFingerprint = remoteSnapshot.fingerprint;
        cache.lastRemoteBranchCheckAt = new Date().toISOString();
      }
      upsertProjectLinkCache(db, cache);
      log(`  ${branchCount} branches, default: ${defaultBranch ?? "unknown"}`);
    }
  } else {
    log("  Branches up to date (refs unchanged, synced < 1 hour ago)");
    if (remoteSnapshot && !options.dryRun) {
      cache.lastRemoteBranchCheckAt = new Date().toISOString();
      upsertProjectLinkCache(db, cache);
    }
  }

  // 3b. Commits
  let commitCount = 0;

  if (!options.skipCommits) {
    currentStep = "Collect commits";
    // Collect commits and resolve per-commit branch assignment by checking
    // all refs, including local-only branches that are not checked out.
    const commits = await runStep(currentStep, () => collectCommitLogs(projectRoot, {
      allRefs: true,
    }));
    const totalCommits = await runStep(currentStep, () => collectCommitCount(projectRoot));

    // Resolve branch for each commit using collected branch data
    if (commits.length > 0) {
      await runStep(currentStep, () => resolveCommitBranches(projectRoot, commits, allBranches, defaultBranch));
    }

    if (commits.length === 0) {
      log("  No new commits to upload.");
      commitCount = totalCommits;
    } else if (options.dryRun) {
      const commitsToUpload = filterWorkspaceDuplicateCommits(
        commits,
        workspaceCommitDedupeState,
      );
      const skipped = commits.length - commitsToUpload.length;
      const skippedLabel = skipped > 0 ? `, ${skipped} already uploaded from another repository` : "";
      log(`  [dry-run] Would upload ${commitsToUpload.length} commits (${totalCommits} total${skippedLabel})`);
      commitCount = totalCommits;
      rememberWorkspaceCommits(commits, workspaceCommitDedupeState);
    } else {
      const commitsToUpload = filterWorkspaceDuplicateCommits(
        commits,
        workspaceCommitDedupeState,
      );
      // Upload in batches
      let uploaded = 0;
      if (commitsToUpload.length === 0) {
        log(`  ${commits.length} commits already uploaded from another repository of this project.`);
      } else {
        // Attach changed-file lists to the newest commits (commits arrive
        // newest-first from git log). Fail-open: an empty map only means
        // uploads go out without file lists.
        currentStep = "Collect commit file stats";
        const fileStatTargets = commitsToUpload
          .slice(0, COMMIT_FILE_STAT_LIMIT)
          .map((c) => c.sha);
        const fileStatsBySha = await runStep(currentStep, () =>
          collectCommitFileStats(projectRoot, fileStatTargets)
        );
        for (const c of commitsToUpload) {
          const files = fileStatsBySha.get(c.sha);
          if (files && files.length > 0) c.files = files;
        }

        for (let i = 0; i < commitsToUpload.length; i += COMMIT_BATCH_SIZE) {
          const batch = commitsToUpload.slice(i, i + COMMIT_BATCH_SIZE);
          currentStep = "Upload commits";
          const response = await runStep(currentStep, () =>
            client.post<CommitUploadResponse>(
              "/api/project-link/commits",
              {
                localProjectId,
                localRepositoryId: repositoryId,
                relativePath: repository.relativePath,
                sinceCommitSha: null,
                commits: batch.map((c) => ({
                  sha: c.sha,
                  parentSha: c.parentSha,
                  authorName: c.authorName,
                  authorEmail: c.authorEmail,
                  date: c.date,
                  message: c.message,
                  branch: c.branch,
                  ...(c.files && c.files.length > 0 ? { files: c.files } : {}),
                })),
              },
            )
          );
          uploaded += response.accepted;
          commitCount = response.totalCommits;

          // Show progress for large uploads
          if (commitsToUpload.length > COMMIT_BATCH_SIZE) {
            const done = Math.min(i + COMMIT_BATCH_SIZE, commitsToUpload.length);
            log(`  Uploading commits... ${done}/${commitsToUpload.length}`);
          }
        }
      }

      rememberWorkspaceCommits(commits, workspaceCommitDedupeState);
      log(`  ${uploaded} new commits uploaded (${commitCount} total)`);
    }

    if (!options.dryRun && currentRefsFingerprint) {
      cache.gitRefHeads = branchHeadMap(allBranches);
      cache.gitRefsFingerprint = currentRefsFingerprint;
      cache.updatedAt = new Date().toISOString();
      upsertProjectLinkCache(db, cache);
    }
  } else {
    log("  Skipping commit history (--skip-commits)");
  }
  endStep("Upload git metadata", step2Start);

  // ──────────────────────────────────────────────────────────
  // Step 4: Discover project documents
  // ──────────────────────────────────────────────────────────

  let documentCount = 0;
  let discoveredDocs: DiscoveredDocument[] = [];
  const step3Start = startStep();

  if (!options.skipDocs) {
    currentStep = "Discover documents";
    log("\n[Step 3/4] Discovering project documents...");

    const docSettings = runStepSync(currentStep, () => loadDocSettings(projectRoot));
    discoveredDocs = runStepSync(currentStep, () => discoverDocuments(projectRoot, cache.docHashes, docSettings));

    if (discoveredDocs.length === 0) {
      log("  No documents found matching patterns.");
    } else {
      log(`  Found ${discoveredDocs.length} document${discoveredDocs.length !== 1 ? "s" : ""}:`);
      for (const doc of discoveredDocs) {
        const sizeKB = (doc.sizeBytes / 1024).toFixed(1);
        const tag = doc.status === "new" ? "[NEW]    " :
          doc.status === "changed" ? "[CHANGED]" :
            "[SKIP]   ";
        log(`    ${tag} ${doc.sourcePath} (${sizeKB} KB)`);
      }

      // Warn if many documents matched
      if (discoveredDocs.length > 50) {
        log(`\n  Warning: ${discoveredDocs.length} documents found. Consider narrowing patterns in settings.json`);
      }
    }

    // ──────────────────────────────────────────────────────────
    // Step 5: Upload documents
    // ──────────────────────────────────────────────────────────

    const toUpload = discoveredDocs.filter((d) => d.status !== "unchanged");

    if (toUpload.length === 0) {
      log("\n[Step 4/4] All documents up to date.");
      documentCount = discoveredDocs.length;
    } else if (options.dryRun) {
      log(`\n[Step 4/4] [dry-run] Would upload ${toUpload.length} document${toUpload.length !== 1 ? "s" : ""}`);
      documentCount = discoveredDocs.length;
    } else {
      log(`\n[Step 4/4] Uploading ${toUpload.length} document${toUpload.length !== 1 ? "s" : ""}...`);

      currentStep = "Upload documents";
      const response = await runStep(currentStep, () =>
        client.post<DocumentUploadResponse>(
          "/api/project-link/documents",
          {
            localProjectId,
            localRepositoryId: repositoryId,
            relativePath: repository.relativePath,
            documents: toUpload.map((d) => ({
              fileName: d.fileName,
              sourcePath: cloudDocumentSourcePath(repository, d.sourcePath),
              content: d.content,
              contentHash: d.contentHash,
            })),
          },
        )
      );

      const s = response.summary;
      log(`  ${s.total} documents processed (${s.created} new, ${s.updated} updated, ${s.unchanged} unchanged)`);
      documentCount = discoveredDocs.length;

      // Update cached hashes
      const newHashes = { ...cache.docHashes };
      for (const doc of discoveredDocs) {
        newHashes[doc.sourcePath] = doc.contentHash;
      }
      updateCachedDocHashes(db, localProjectId, serverUrl, newHashes, repositoryId);
      cache.docHashes = newHashes;
    }
  } else {
    log("\n[Step 3/4] Skipping document upload (--skip-docs)");
    log("\n[Step 4/4] Skipping document upload (--skip-docs)");
  }
  endStep("Discover & upload documents", step3Start);


  const totalDurationMs = Math.round(performance.now() - totalStart);

  // ──────────────────────────────────────────────────────────
  // Final: Summary
  // ──────────────────────────────────────────────────────────

  log("");
  log("══════════════════════════════════════════");
  log("Project link complete!");
  log(`Project:    ${cloudProjectName}`);
  log(`Server:     ${serverUrl}`);
  log(`Branches:   ${branchCount}`);
  log(`Commits:    ${commitCount}`);
  log(`Documents:  ${documentCount}`);
  log("──────────────────────────────────────────");
  for (const t of stepTimings) {
    log(`  ${t.step.padEnd(28)} ${formatDuration(t.durationMs)}`);
  }
  log(`  ${"Total".padEnd(28)} ${formatDuration(totalDurationMs)}`);
  log("══════════════════════════════════════════");

  return {
    projectId: serverProjectId,
    localProjectId,
    localRepositoryId: repositoryId,
    relativePath: repository.relativePath,
    serverProjectId,
    projectName: cloudProjectName,
    canonicalRepoKey,
    serverUrl,
    branchCount,
    commitCount,
    documentCount,
    stepTimings,
    totalDurationMs,
    ...(negotiate.similarProjects && negotiate.similarProjects.length > 0
      ? { similarProjects: negotiate.similarProjects }
      : {}),
  };
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * Examples: "42ms", "1.2s", "2m 3s"
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function createWorkspaceLinkResult(
  results: LinkResult[],
  failures: WorkspaceLinkFailure[],
  projectId: string,
  projectName: string,
  serverUrl: string,
  totalDurationMs: number,
): LinkResult {
  const repositoryResults = results.map(toWorkspaceRepositoryResult);
  const repositoryFailures = failures.map(({ localRepositoryId, relativePath, step, message, status, response }) => ({
    localRepositoryId,
    relativePath,
    ...(step ? { step } : {}),
    message,
    ...(status ? { status } : {}),
    ...(response !== undefined ? { response } : {}),
  }));

  return {
    projectId: results[0]?.projectId ?? projectId,
    localProjectId: projectId,
    localRepositoryId: "*",
    relativePath: "*",
    serverProjectId: results[0]?.serverProjectId ?? projectId,
    projectName,
    canonicalRepoKey: null,
    serverUrl,
    branchCount: results.reduce((sum, result) => sum + result.branchCount, 0),
    commitCount: results.reduce((sum, result) => sum + result.commitCount, 0),
    documentCount: results.reduce((sum, result) => sum + result.documentCount, 0),
    stepTimings: results.flatMap((result) => result.stepTimings),
    totalDurationMs,
    repositoryResults,
    repositoryFailures,
  };
}

function toWorkspaceRepositoryResult(result: LinkResult): WorkspaceRepositoryResult {
  return {
    localRepositoryId: result.localRepositoryId,
    relativePath: result.relativePath,
    branchCount: result.branchCount,
    commitCount: result.commitCount,
    documentCount: result.documentCount,
    totalDurationMs: result.totalDurationMs,
  };
}

function logWorkspaceRepositoryResult(
  index: number,
  total: number,
  result: LinkResult,
  log: (message?: unknown) => void,
): void {
  log(
    `[${index}/${total}] ${result.relativePath} ok | branches ${result.branchCount} | ` +
    `commits ${result.commitCount} | docs ${result.documentCount} | ` +
    formatDuration(result.totalDurationMs),
  );
}

function logWorkspaceRepositoryStart(
  index: number,
  total: number,
  repository: CloudRepository,
  log: (message?: unknown) => void,
): void {
  log(`[${index}/${total}] ${repository.relativePath} linking...`);
}

function logWorkspaceRepositoryFailure(
  index: number,
  total: number,
  failure: WorkspaceRepositoryFailure,
  log: (message?: unknown) => void,
): void {
  log(`[${index}/${total}] ${failure.relativePath} failed | ${formatFailureLine(failure)}`);
}

function logWorkspaceSummary(
  result: LinkResult,
  failures: WorkspaceRepositoryFailure[],
  log: (message?: unknown) => void,
): void {
  const successful = result.repositoryResults?.length ?? 0;
  const failed = failures.length;

  log("");
  log("══════════════════════════════════════════");
  log("Link complete!");
  log(`Project:      ${result.projectName}`);
  log(`Server:       ${result.serverUrl}`);
  log(`Repositories: ${successful} succeeded, ${failed} failed`);
  log(`Branches:     ${result.branchCount}`);
  log(`Commits:      ${result.commitCount}`);
  log(`Documents:    ${result.documentCount}`);
  log(`Total:        ${formatDuration(result.totalDurationMs)}`);

  if (failures.length > 0) {
    log("──────────────────────────────────────────");
    log("Failures:");
    for (const failure of failures) {
      log(`  ${failure.relativePath}: ${formatFailureLine(failure)}`);
    }
  }

  log("══════════════════════════════════════════");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runLinkStep<T>(
  step: string,
  operation: () => Promise<T>,
  wrapErrors: boolean,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (wrapErrors && !(error instanceof LinkStepError)) {
      throw new LinkStepError(step, error);
    }
    throw error;
  }
}

function runLinkStepSync<T>(step: string, operation: () => T, wrapErrors: boolean): T {
  try {
    return operation();
  } catch (error) {
    if (wrapErrors && !(error instanceof LinkStepError)) {
      throw new LinkStepError(step, error);
    }
    throw error;
  }
}

function errorStep(error: unknown): string | undefined {
  return error instanceof LinkStepError ? error.step : undefined;
}

function rootError(error: unknown): unknown {
  return error instanceof LinkStepError ? error.cause : error;
}

function errorStatus(error: unknown): number | undefined {
  const cause = rootError(error);
  return cause instanceof CloudApiError ? cause.status : undefined;
}

function errorResponse(error: unknown): unknown {
  const cause = rootError(error);
  return cause instanceof CloudApiError ? cause.body : undefined;
}

function formatFailureMessage(error: unknown): string {
  const cause = rootError(error);
  return cause instanceof CloudApiError
    ? `API error ${cause.status}: ${cause.message.replace(/^API error:\s*\d+\s*/u, "")}`
    : errorMessage(cause);
}

function formatFailureLine(failure: WorkspaceRepositoryFailure): string {
  const response = formatFailureResponse(failure.response);
  const message = response ? `${failure.message} | ${response}` : failure.message;
  return failure.step ? `${failure.step}: ${message}` : message;
}

function formatFailureResponse(response: unknown): string | null {
  if (response === undefined || response === null) return null;
  if (typeof response === "string") return truncate(response);
  if (typeof response === "number" || typeof response === "boolean") return String(response);

  const record = asRecord(response);
  const directMessage =
    readString(record.message) ??
    readString(record.error) ??
    readString(record.reason) ??
    readString(record.code);

  if (directMessage) return truncate(directMessage);

  try {
    return truncate(JSON.stringify(response));
  } catch {
    return String(response);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function truncate(value: string): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  return singleLine.length > 300 ? `${singleLine.slice(0, 297)}...` : singleLine;
}
