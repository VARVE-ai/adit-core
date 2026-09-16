export { openDatabase, closeDatabase } from "./connection.js";

export {
  insertSession,
  getSessionById,
  getLatestSession,
  getSessionByPlatformSessionId,
  insertSessionPlatformAlias,
  listSessionPlatformAliases,
  listRecentSessions,
  mergeSessionInto,
  listSessions,
  type CreateSessionInput,
} from "./sessions.js";

export {
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
