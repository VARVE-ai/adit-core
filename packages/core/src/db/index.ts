export { openDatabase, closeDatabase } from "./connection.js";
export { migrations } from "./migrations.js";

export {
  insertSession,
  getSessionById,
  getActiveSession,
  getSessionByPlatformSessionId,
  endSession,
  endStaleSessions,
  listSessions,
  type CreateSessionInput,
} from "./sessions.js";

export {
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
  type InsertEventInput,
  type EventQueryOptions,
} from "./events.js";

export {
  insertDiff,
  getDiffByEventId,
  getDiffText,
  type DiffRecord,
} from "./diffs.js";

export {
  insertPlan,
  getPlanById,
  listPlans,
  getChildPlans,
  updatePlanStatus,
  updatePlanContent,
  type CreatePlanInput,
} from "./plans.js";

export {
  insertEnvSnapshot,
  getEnvSnapshotById,
  getLatestEnvSnapshot,
  listEnvSnapshots,
  type CreateEnvSnapshotInput,
} from "./env-snapshots.js";

export {
  getSyncState,
  upsertSyncState,
  applyAuthoritativeSyncState,
  clearSyncState,
  type SyncState,
} from "./sync-state.js";

export {
  getSessionRepoHeads,
  upsertSessionRepoHead,
  type SessionRepoHead,
} from "./session-repo-heads.js";

export {
  upsertTranscriptUpload,
  getTranscriptUpload,
  getTranscriptUploadById,
  listPendingTranscriptUploads,
  markTranscriptUploaded,
  markTranscriptUploadFailed,
  resetTranscriptUpload,
  countActiveTranscriptUploads,
  type TranscriptUpload,
  type TranscriptUploadStatus,
  type UpsertTranscriptUploadInput,
} from "./transcript-uploads.js";
