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
