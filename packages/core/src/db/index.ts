export { openDatabase, closeDatabase } from "./connection.js";
export { migrations } from "./migrations.js";

export {
  insertSession,
  getSessionById,
  getLatestSession,
  getSessionByPlatformSessionId,
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
  hasGitOperationEvent,
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
