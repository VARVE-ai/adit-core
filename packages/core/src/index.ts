/**
 * @varveai/adit-core — Core types, database, config, and sync primitives.
 *
 * This is the foundation package. All other ADIT packages depend on it.
 */

// Types
export type {
  EventType,
  Actor,
  EventStatus,
  ErrorCategory,
  FileStat,
  EventError,
  AditEvent,
} from "./types/index.js";
export { parseLabels, parseDiffStats, parseError } from "./types/index.js";

// Cloud server identity
export { normalizeServerUrl } from "./server-url.js";

export type {
  Platform,
  SessionType,
  SessionMetadata,
  AditSession,
} from "./types/index.js";

export type { EnvSnapshot, EnvDiff, EnvChange } from "./types/index.js";

// Database
export { normalizeUsage, sanitizeUsage } from "./usage.js";
export type { TokenUsageRecord } from "./usage.js";
export { readTokenCaptureState, readSessionUsageRecords, storeSessionUsage, attachPendingTokenUsage, eventUsageFromRow, summarizeEventUsage } from "./db/event-token-usage.js";
export type { EventTokenUsage } from "./db/event-token-usage.js";

export {
  openDatabase,
  closeDatabase,
  insertSession,
  getSessionById,
  getLatestSession,
  getSessionByPlatformSessionId,
  insertSessionPlatformAlias,
  listSessionPlatformAliases,
  listRecentSessions,
  mergeSessionInto,
  listSessions,
  insertEvent,
  insertEventAutoSeq,
  getEventById,
  queryEvents,
  getEventsBySession,
  getLastEventOfSession,
  updateEventStatus,
  updateEventLabels,
  searchEvents,
  clearEvents,
  countEvents,
  hasGitCommitEvent,
  insertDiff,
  getDiffByEventId,
  getDiffText,
  insertEnvSnapshot,
  getEnvSnapshotById,
  getLatestEnvSnapshot,
  listEnvSnapshots,
  getSyncState,
  upsertSyncState,
  applyAuthoritativeSyncState,
  clearSyncState,
} from "./db/index.js";

export type {
  CreateSessionInput,
  InsertEventInput,
  EventQueryOptions,
  DiffRecord,
  CreateEnvSnapshotInput,
  SyncState,
} from "./db/index.js";

// Config
export {
  loadConfig,
  findGitRoot,
  projectNameFromRoot,
  redactSensitiveKeys,
  type AditConfig,
  type ProjectInitializationState,
} from "./config/index.js";

export {
  projectManifestRelativePath,
  projectManifestPath,
  workspaceManifestRelativePath,
  generateProjectId,
  generateRepositoryId,
  computeRepoProjectId,
  computeLocalRepositoryId,
  readProjectManifest,
  validateProjectManifest,
  writeProjectManifest,
  withProjectInitLock,
  findProjectManifestRoot,
  findRegisteringParent,
  resolveManifestRepositories,
  resolveActiveManifestRepositories,
  hasLegacyProjectTraces,
  readWorkspaceManifest,
  discoverWorkspaceRepositories,
  computeRepositoryDrift,
  toRepositoryPayload,
  deriveProjectType,
  isRootRepositoryPath,
  toCurrentManifestSchema,
  MANIFEST_SCHEMA_VERSION,
  ProjectManifestError,
  ProjectInitLockError,
  type ProjectManifest,
  type ProjectManifestRepository,
  type ProjectType,
  type WorkspaceManifest,
  type LocalRepository,
} from "./config/project.js";

// Performance logging
export {
  recordPerf,
  withPerf,
  withPerfSync,
  readPerfLogs,
  generatePerfStats,
  clearPerfLogs,
  pruneOldLogs,
  type PerfEntry,
  type PerfOperationStats,
  type PerfStatsReport,
} from "./perf/perf-log.js";

export { recordAgentRuntime, readAgentRuntimeVersions } from "./config/runtime-agents.js";
export * from "./local-state.js";
export * from "./local-projects.js";
export * from "./project-resolution.js";
export * from "./local-registration.js";
export { analyticsSessions } from "./local-history/analytics-scope.js";
export { promptText } from "./local-history/prompt-summary.js";
export { createAttributionSchema, ATTRIBUTION_RESULT_TABLES } from './local-history/attribution-schema.js';
export { NON_MERGE_COMMIT_SQL } from './local-history/commit-policy.js';
export { insideDirectory } from "./local-history/sources.js";
export { redactOverview } from "./local-history/analytics.js";
export * from "./local-history/sources.js";
export * from "./local-history/archive.js";
export { isRetryableCollectionIssue } from "./local-history/collection-issues.js";
export * from "./local-history/analytics.js";
export * from "./local-history/achievements.js";
export * from "./local-history/achievement-rules.js";
export * from "./local-history/inspection.js";
export * from "./local-history/secret-detector.js";
export * from "./local-history/session-browser.js";
export * from "./local-history/sharing.js";
export * from "./local-history/pr-descriptions.js";
export { LocalPrices } from "./local-history/pricing.js";

// Sync primitives
export {
  generateId,
  generateIdAt,
  extractTimestamp,
  type VectorClock,
  createClock,
  tick,
  merge,
  compare,
  serialize,
  deserialize,
} from "./sync/index.js";
export { nativeConversationId, conversationSegments, conversationScope } from "./local-history/session-identity.js";
export { submittedPromptText, promptImageCount, PROMPT_IMAGE_KINDS } from "./local-history/prompt-summary.js";
export { nativeContextKind, nativeContextSql, historyFinalReply, replyCompleted } from "./local-history/message-semantics.js";
