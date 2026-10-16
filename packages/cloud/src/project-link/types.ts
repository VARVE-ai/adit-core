/**
 * Type definitions for the Project Link feature.
 *
 * Covers git metadata collection, document discovery, local cache,
 * server API request/response shapes, and command options.
 */

// ─── Git Collection ────────────────────────────────────────

export interface GitBranch {
  name: string;
  headSha: string;
  isDefault: boolean;
}

/** Authoritative branch snapshot read directly from the configured Git remote. */
export interface RemoteBranchSnapshot {
  branches: GitBranch[];
  /** Stable hash of sorted branch names and heads, used to avoid redundant uploads. */
  fingerprint: string;
}

export interface GitCommit {
  sha: string;
  parentSha: string | null;
  authorName: string;
  authorEmail: string;
  date: string; // ISO 8601
  message: string;
  branch?: string;
  /** Changed files (numstat); attached only for recent commits before upload. */
  files?: GitCommitFileStat[];
}

export interface GitCommitFileStat {
  path: string;
  additions: number;
  deletions: number;
}

export interface GitIdentity {
  authorName: string | null;
  authorEmail: string | null;
}

// ─── Document Discovery ────────────────────────────────────

export interface DiscoveredDocument {
  /** File name (e.g. "README.md") */
  fileName: string;
  /** Relative path from project root (e.g. "docs/architecture.md") */
  sourcePath: string;
  /** Full file content */
  content: string;
  /** SHA-256 hex digest of content */
  contentHash: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Status relative to the cached hash */
  status: "new" | "changed" | "unchanged";
}

// ─── Local Cache ───────────────────────────────────────────

export interface ProjectLinkCache {
  /** Local project ID from the client config; used as the cache key. */
  projectId: string;
  /** Local repository ID within the project; equals projectId for normal repo projects. */
  repositoryId: string;
  serverUrl: string;
  /** Effective cloud project ID returned by the server, for display/debug only. */
  confirmedProjectId: string | null;
  /** Last successfully uploaded branch heads, keyed by normalized branch name. */
  gitRefHeads: Record<string, string>;
  /** Fingerprint of all local and remote-tracking refs at the last successful git sync. */
  gitRefsFingerprint: string | null;
  /** Fingerprint of the last authoritative origin branch snapshot uploaded to Cloud. */
  remoteRefsFingerprint: string | null;
  /** Last successful read of origin branches, whether or not an upload was needed. */
  lastRemoteBranchCheckAt: string | null;
  lastBranchSyncAt: string | null;
  lastDocSyncAt: string | null;
  docHashes: Record<string, string>; // sourcePath → contentHash
  initializedAt: string;
  updatedAt: string;
}

// ─── Server API Responses ──────────────────────────────────

export interface NegotiateResponse {
  localProjectId: string;
  serverProjectId: string;
  confirmedProjectId: string;
  projectName: string;
  canonicalRepoKey?: string | null;
  status: "confirmed" | "id_mismatch";
  message: string;
  /**
   * Present only when this negotiate created a brand-new cloud project and the
   * user already has projects pointing at the same git remotes (fresh clone /
   * new machine). Advisory — the server never merges.
   */
  similarProjects?: Array<{ name: string | null; lastActivityAt: string }>;
}

export interface LinkInitResponse {
  projectLink: {
    id: string;
    localProjectId: string;
    projectId: string;
    serverProjectId: string;
    remoteUrl: string;
    canonicalRepoKey?: string | null;
    defaultBranch: string | null;
    gitAuthorName: string | null;
    gitAuthorEmail: string | null;
    branchCount: number;
    lastGitSyncAt: string | null;
    lastDocSyncAt: string | null;
    remoteBranchesCheckedAt?: string | null;
    createdAt: string;
  };
  status: "created" | "updated";
}

export interface CommitUploadResponse {
  localProjectId?: string;
  serverProjectId?: string;
  canonicalRepoKey?: string | null;
  accepted: number;
  duplicates: number;
  totalCommits: number;
  latestCommitSha: string;
}

export interface DocumentUploadResponse {
  localProjectId?: string;
  serverProjectId?: string;
  canonicalRepoKey?: string | null;
  results: Array<{
    fileName: string;
    documentId: string;
    status: "created" | "new_version" | "unchanged";
    versionNumber?: number;
  }>;
  summary: {
    created: number;
    updated: number;
    unchanged: number;
    total: number;
  };
}

// ─── Command Options ───────────────────────────────────────

export interface LinkOptions {
  force?: boolean;
  skipDocs?: boolean;
  skipCommits?: boolean;
  dryRun?: boolean;
  json?: boolean;
  /**
   * Suppress the built-in progress output; the caller renders progress and
   * results itself (used when link runs embedded in `adit init`). Step
   * failures are wrapped in LinkStepError so the failing step is named.
   */
  silent?: boolean;
  /** Internal: the CLI already refreshed deletion policy before local prechecks. */
  deletionPolicyRefreshed?: boolean;
  /** Invoked as each link step completes (per repository in workspaces). */
  onStepComplete?: (step: StepTiming) => void;
  /** Invoked when a repository starts linking, so callers can show progress. */
  onRepositoryStart?: (progress: { index: number; total: number; relativePath: string }) => void;
  /** Invoked when a repository finished linking, with its counts or its failure. */
  onRepositoryDone?: (progress: {
    index: number;
    total: number;
    result?: WorkspaceRepositoryResult;
    failure?: WorkspaceRepositoryFailure;
  }) => void;
}

// ─── Step Timing ───────────────────────────────────────────

export interface StepTiming {
  /** Human-readable step name (e.g. "Negotiate project ID") */
  step: string;
  /** Duration in milliseconds */
  durationMs: number;
}

// ─── Command Results ───────────────────────────────────────

export interface LinkResult {
  /** Cloud project ID returned by the server. */
  projectId: string;
  /** Client-local project ID computed from the local repo. */
  localProjectId: string;
  /** Client-local repository ID within the project. */
  localRepositoryId: string;
  /** Repository path relative to the project root. */
  relativePath: string;
  /** Cloud project ID returned by the server. */
  serverProjectId: string;
  projectName: string;
  canonicalRepoKey: string | null;
  serverUrl: string;
  branchCount: number;
  commitCount: number;
  documentCount: number;
  /** Per-step timing breakdown */
  stepTimings: StepTiming[];
  /** Total wall-clock duration in milliseconds */
  totalDurationMs: number;
  /** Per-repository successful results for workspace projects. */
  repositoryResults?: WorkspaceRepositoryResult[];
  /** Per-repository failures for workspace projects. */
  repositoryFailures?: WorkspaceRepositoryFailure[];
  /** Existing same-remote projects reported by negotiate when this link created a new project. */
  similarProjects?: Array<{ name: string | null; lastActivityAt: string }>;
}

export interface WorkspaceRepositoryResult {
  localRepositoryId: string;
  relativePath: string;
  branchCount: number;
  commitCount: number;
  documentCount: number;
  totalDurationMs: number;
}

export interface WorkspaceRepositoryFailure {
  localRepositoryId: string;
  relativePath: string;
  step?: string;
  message: string;
  status?: number;
  response?: unknown;
}
