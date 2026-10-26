/**
 * Project Link — public API for connecting a local codebase to adit-cloud.
 *
 * Exports command handlers, utility functions, and type definitions
 * for the `/adit link` plugin command.
 */

// Command handlers
export { linkCommand, WorkspaceLinkPartialFailureError } from "./link-command.js";

// Quality check

// Repository key normalization
export { normalizeGitHubRepoKey } from "./repo-key.js";

// Git collection
export {
  collectRemoteUrl,
  collectDefaultBranch,
  collectCurrentBranch,
  collectBranches,
  collectRemoteBranchSnapshot,
  branchHeadMap,
  collectGitRefsFingerprint,
  collectCommitLogs,
  collectCommitsBetweenRefSnapshots,
  resolveCommitBranches,
  collectCommitCount,
  projectNameFromRemoteUrl,
} from "./git-collector.js";

// Document discovery
export { discoverDocuments, loadDocSettings } from "./doc-discovery.js";

// Local cache
export {
  getProjectLinkCache,
  upsertProjectLinkCache,
  clearProjectLinkCache,
  updateCachedGitState,
} from "./cache.js";

export {
  syncLinkedGitMetadata,
  type GitSyncResult,
  type GitSyncFailure,
  type GitSyncSkip,
  type GitSyncSkipReason,
} from "./git-sync.js";

// Types
export type {
  GitBranch,
  GitCommit,
  DiscoveredDocument,
  ProjectLinkCache,
  StepTiming,
  LinkOptions,
  LinkResult,
  WorkspaceRepositoryResult,
  WorkspaceRepositoryFailure,
} from "./types.js";
