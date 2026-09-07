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
  qualified: boolean;
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
    qualified: boolean;
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

export interface QualifyDocumentDetail {
  fileName: string;
  detectedType: string;
  structuralScore: number;
  missingSections: string[];
  hasStubContent: boolean;
}

export interface QualifyResponse {
  qualified: boolean;
  score: number;
  documentCount: number;
  documentDetails?: QualifyDocumentDetail[];
  feedback: {
    missing: string[];
    suggestions: string[];
    summaryPrompt: string;
  } | null;
}

// ─── Intent Types ──────────────────────────────────────────

export interface IntentSummary {
  id: string;
  title: string;
  businessGoal: string;
  state: string;
  ambiguityScore: number | null;
  linkedBranches: string[];
  taskCount: number;
  completedTaskCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface IntentDetail extends IntentSummary {
  acceptanceMd: string | null;
  antiGoals: string | null;
  clarityScores: {
    goal: number;
    constraints: number;
    criteria: number;
    context: number;
  } | null;
  tasks: TaskSlice[];
  plans: PromptVersion[];
  recentShipNotes: Array<{
    id: string;
    noteBody: string;
    createdBy: string;
    architecturalDecision: boolean;
    createdAt: string;
  }>;
}

export interface TaskSlice {
  id: string;
  title: string;
  description: string | null;
  phase: number;
  phaseTitle: string | null;
  phaseChecklist: Array<{ item: string; checked: boolean }>;
  sortOrder: number;
  wave: number | null;
  complexityScore: number | null;
  approvalStatus: string;
  featureTag: string | null;
  acceptanceCriteria: {
    criteria: string[];
    assertions: Array<{
      type: string;
      description: string;
      path?: string;
    }>;
  };
  linkedEventIds: string[];
  dependsOn: number[];
  codingPrompt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PromptVersion {
  version: number;
  versionType: string;
  promptText: string | null;
  responsePayload: string;
  llmModel: string | null;
  llmParamsJson: string | null;
  sourceEventId: string | null;
  gatekeeperVerdict: string | null;
  gatekeeperReport: string | null;
  parentVersionId: string | null;
  createdAt: string;
}

// ─── Command Options ───────────────────────────────────────

export interface LinkOptions {
  force?: boolean;
  skipDocs?: boolean;
  skipCommits?: boolean;
  skipQualify?: boolean;
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
}

export interface IntentOptions {
  id?: string;
  state?: string;
  json?: boolean;
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
  qualified: boolean;
  score: number | null;
  lowScoreDocumentCount?: number;
  stubDocumentCount?: number;
  lowestScoringDocuments?: Array<{
    fileName: string;
    score: number;
    detectedType: string;
  }>;
  missingItems?: string[];
  suggestions?: string[];
  qualityFeedback?: string | null;
  summaryPrompt?: string | null;
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
  qualified: boolean;
  score: number | null;
  lowScoreDocumentCount?: number;
  stubDocumentCount?: number;
  lowestScoringDocuments?: Array<{
    fileName: string;
    score: number;
    detectedType: string;
  }>;
  missingItems?: string[];
  suggestions?: string[];
  qualityFeedback?: string | null;
  summaryPrompt?: string | null;
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

export interface IntentResult {
  intents?: IntentSummary[];
  intent?: IntentDetail;
}

// ─── Bulk Task Update Types ─────────────────────────────────

export interface BulkTaskFilter {
  /** Filter by phase number (1-99) */
  phase?: number;
  /** Filter by task status */
  status?: "pending" | "approved" | "in_progress" | "completed" | "rejected";
  /** Filter by feature tag */
  featureTag?: string;
  /** Filter by wave number */
  wave?: number;
}

export interface BulkTaskUpdate {
  /** Task ID to update — must be "*" for phase/intent level operations */
  taskId: string;
  /** New status for the task */
  status: "pending" | "approved" | "in_progress" | "completed" | "rejected";
  /** Optional phase number */
  phase?: number;
  /** Optional title update */
  title?: string;
  /** Optional description update */
  description?: string;
}

export interface BulkTaskUpdateOptions {
  /** Intent ID containing the tasks to update */
  intentId: string;
  /** Target status (default: "completed") */
  status?: "pending" | "approved" | "in_progress" | "completed" | "rejected";
  /** Filters to apply before updating */
  filters?: BulkTaskFilter;
  /** Output as JSON */
  json?: boolean;
}

export interface BulkTaskUpdateResult {
  /** Number of tasks successfully updated */
  updated: number;
  /** Array of failed updates with error details */
  failed: Array<{
    taskId: string;
    error: string;
  }>;
  /** Summary message */
  message: string;
  /** Intent state transition if triggered */
  intentTransitioned?: "shipped" | null;
}
