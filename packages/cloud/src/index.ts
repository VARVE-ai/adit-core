/**
 * @varveai/adit-cloud — Cloud sync client for ADIT.
 *
 * Provides device authorization, HTTP client with auto-refresh,
 * cursor-based incremental sync engine, and conflict resolution.
 */

// Config
export { loadCloudConfig, DEFAULT_SERVER_URL, type CloudConfig } from "./config.js";
export { normalizeServerUrl } from "@varveai/adit-core";
export {
  resolveCloudProjectContext,
  repositoryPayloads,
  type CloudProjectContext,
  type CloudRepository,
} from "./project-context.js";
export {
  applyProjectDeletionPolicy,
  refreshProjectDeletionPolicy,
  CloudProjectDeletedError,
  type DeletedRepositoryPolicy,
  type ProjectDeletionPolicy,
} from "./project-deletion-policy.js";

// Auth
export {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  updateCloudAccountMetadata,
  type CloudAccountMetadata,
  isTokenExpired,
  credentialsFromEnvToken,
  incrementSyncErrors,
  clearSyncErrors,
  isSyncDisabled,
  recordAuthFailure,
  clearAuthFailure,
  type CloudCredentials,
  type CloudAuthFailure,
  type CloudAuthFailureStage,
} from "./auth/credentials.js";
export {
  requestDeviceCode,
  pollForToken,
  type DeviceCodeResponse,
  type TokenResponse,
  type DeviceAuthOptions,
} from "./auth/device-auth.js";

// HTTP
export { CloudClient, type CloudClientOptions, type RefreshTokenStatus } from "./http/client.js";
export {
  CloudAuthError,
  CloudNetworkError,
  CloudApiError,
} from "./http/errors.js";

// Sync
export {
  SyncEngine,
  type SyncResult,
  type SyncConflict,
} from "./sync/engine.js";
export { runSyncCycle, type SyncCycleResult } from "./sync/sync-cycle.js";
export {
  buildSyncBatch,
  countUnsyncedEvents,
  batchRecordCount,
  type SyncBatch,
} from "./sync/serializer.js";
export { triggerAutoSync } from "./sync/auto-sync.js";
export { formatUpgradeNotice } from "./sync/runtime-report.js";
export type { RuntimeReport, UpgradeNotice } from "./sync/runtime-report.js";

// Project Link
export {
  linkCommand,
  WorkspaceLinkPartialFailureError,
  collectRemoteUrl,
  collectBranches,
  branchHeadMap,
  collectGitRefsFingerprint,
  collectCommitLogs,
  collectCommitsBetweenRefSnapshots,
  collectCommitCount,
  collectDefaultBranch,
  collectCurrentBranch,
  projectNameFromRemoteUrl,
  normalizeGitHubRepoKey,
  discoverDocuments,
  loadDocSettings,
  getProjectLinkCache,
  upsertProjectLinkCache,
  clearProjectLinkCache,
  updateCachedGitState,
  syncLinkedGitMetadata,
  type LinkResult,
  type WorkspaceRepositoryResult,
  type WorkspaceRepositoryFailure,
  type LinkOptions,
  type StepTiming,
  type GitBranch,
  type GitCommit,
  type DiscoveredDocument,
  type ProjectLinkCache,
  type GitSyncResult,
  type GitSyncFailure,
  type GitSyncSkip,
  type GitSyncSkipReason,
} from "./project-link/index.js";

export { createCloudTask, listCloudTasks, showCloudTask, cloudTaskContext, updateCloudTask, uploadCloudTaskImage } from "./tasks.js";
export * from "./cli-reads.js";
export * from "./memories.js";
export type { CloudTask, CloudTaskList, CloudTaskDetail, CloudTaskContext, CloudTaskPatch, CloudTaskState, CloudTaskCreate, CloudTaskCreated, CloudTaskAttachment } from "./tasks.js";
