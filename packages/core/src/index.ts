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

export type {
  SessionStatus,
  Platform,
  SessionType,
  SessionMetadata,
  AditSession,
} from "./types/index.js";

export type {
  PlanType,
  PlanStatus,
  AditPlan,
} from "./types/index.js";

export type { EnvSnapshot, EnvDiff, EnvChange } from "./types/index.js";

// Database
export {
  openDatabase,
  closeDatabase,
  insertSession,
  getSessionById,
  getActiveSession,
  getSessionByPlatformSessionId,
  reviveSession,
  mergeSessionMetadata,
  endSession,
  endStaleSessions,
  listSessions,
  insertEvent,
  insertEventAutoSeq,
  getEventById,
  queryEvents,
  getEventsBySession,
  updateEventStatus,
  updateEventLabels,
  searchEvents,
  clearEvents,
  countEvents,
  hasGitCommitEvent,
  insertDiff,
  getDiffByEventId,
  getDiffText,
  insertPlan,
  getPlanById,
  listPlans,
  getChildPlans,
  updatePlanStatus,
  updatePlanContent,
  insertEnvSnapshot,
  getEnvSnapshotById,
  getLatestEnvSnapshot,
  listEnvSnapshots,
  getSyncState,
  upsertSyncState,
  applyAuthoritativeSyncState,
  clearSyncState,
  upsertTranscriptUpload,
  getTranscriptUpload,
  getTranscriptUploadById,
  listPendingTranscriptUploads,
  markTranscriptUploaded,
  markTranscriptUploadFailed,
  resetTranscriptUpload,
  countActiveTranscriptUploads,
  getSessionRepoHeads,
  upsertSessionRepoHead,
} from "./db/index.js";

export type {
  CreateSessionInput,
  InsertEventInput,
  EventQueryOptions,
  DiffRecord,
  CreatePlanInput,
  CreateEnvSnapshotInput,
  SyncState,
  TranscriptUpload,
  TranscriptUploadStatus,
  UpsertTranscriptUploadInput,
  SessionRepoHead,
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
  computeRepoProjectId,
  computeLocalRepositoryId,
  readProjectManifest,
  validateProjectManifest,
  writeProjectManifest,
  withProjectInitLock,
  findProjectManifestRoot,
  resolveManifestRepositories,
  hasLegacyProjectTraces,
  readWorkspaceManifest,
  discoverWorkspaceRepositories,
  toRepositoryPayload,
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
