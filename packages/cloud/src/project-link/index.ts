/**
 * Project Link — public API for connecting a local codebase to adit-cloud.
 *
 * Exports command handlers, utility functions, and type definitions
 * for the `/adit link` and `/adit intent` plugin commands.
 */

// Command handlers
export { linkCommand, WorkspaceLinkPartialFailureError } from "./link-command.js";
export { intentCommand, formatIntentList, formatIntentDetail } from "./intent-command.js";

// Quality check
export { checkQuality, formatQualityFeedback } from "./qualify.js";

// Repository key normalization
export { normalizeGitHubRepoKey } from "./repo-key.js";

// Git collection
export {
  collectRemoteUrl,
  collectDefaultBranch,
  collectCurrentBranch,
  collectGitIdentity,
  collectBranches,
  branchHeadMap,
  collectGitRefsFingerprint,
  collectCommitLogs,
  collectCommitsBetweenRefSnapshots,
  collectCommitCount,
  resolveCommitBranches,
  projectNameFromRemoteUrl,
} from "./git-collector.js";

// Document discovery
export { discoverDocuments, loadDocSettings } from "./doc-discovery.js";

// Local cache
export {
  getProjectLinkCache,
  upsertProjectLinkCache,
  clearProjectLinkCache,
  updateCachedCommitSha,
  updateCachedGitState,
  updateCachedDocHashes,
  updateCachedQualified,
} from "./cache.js";

export { syncLinkedGitMetadata, type GitSyncResult, type GitSyncFailure } from "./git-sync.js";

// Types
export type {
  GitBranch,
  GitCommit,
  GitIdentity,
  DiscoveredDocument,
  ProjectLinkCache,
  NegotiateResponse,
  LinkInitResponse,
  CommitUploadResponse,
  DocumentUploadResponse,
  QualifyResponse,
  LinkStatusResponse,
  IntentSummary,
  IntentDetail,
  TaskSlice,
  StepTiming,
  LinkOptions,
  IntentOptions,
  LinkResult,
  WorkspaceRepositoryResult,
  WorkspaceRepositoryFailure,
  IntentResult,
} from "./types.js";
