/**
 * Data serializer — builds sync batches from local SQLite data.
 *
 * Queries local tables for records not yet synced (after the cursor),
 * converts them to the server's expected format, and respects the
 * batch size limit (max 500 records per push).
 */

import type Database from "better-sqlite3";
import type { TokenUsageRecord } from "@varveai/adit-core";

/** Total diff_text byte cap per push payload. Mirrors agent-file-mutation-capture-plan.md. */
const MAX_SYNC_DIFF_BYTES = 2 * 1024 * 1024;

/** Real UTF-8 byte length — String.length undercounts CJK/emoji up to 3x. */
function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Cut a string to at most maxBytes of UTF-8, without leaving a broken
 * multi-byte sequence (a trailing U+FFFD from a split code point is dropped).
 */
function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return cut.endsWith("�") ? cut.slice(0, -1) : cut;
}

/**
 * Server-facing record types.
 * These use snake_case field names matching the adit-cloud PostgreSQL schema.
 */

export interface SyncSession {
  id: string;
  project_id: string;
  client_id: string;
  session_type: string;
  platform: string;
  started_at: string;
  metadata_json: string | null;
  vclock_json: string | null;
  deleted_at: string | null;
}

export interface SyncEvent {
  id: string;
  session_id: string;
  client_id: string;
  parent_event_id: string | null;
  sequence: number;
  event_type: string;
  actor: string;
  status: string;
  prompt_text: string | null;
  cot_text: string | null;
  response_text: string | null;
  tool_name: string | null;
  tool_input_json: string | null;
  tool_output_json: string | null;
  diff_stat_json: string | null;
  git_branch: string | null;
  git_head_sha: string | null;
  env_snapshot_id: string | null;
  started_at: string;
  ended_at: string | null;
  error_json: string | null;
  labels_json: string | null;
  vclock_json: string | null;
  deleted_at: string | null;
}

export interface SyncEnvSnapshot {
  id: string;
  session_id: string;
  client_id: string;
  git_branch: string | null;
  git_head_sha: string | null;
  modified_files: string | null;
  lockfile_hash: string | null;
  lockfile_path: string | null;
  env_vars: string | null;
  node_version: string | null;
  python_version: string | null;
  os_info: string | null;
  container_info: string | null;
  runtime_versions: string | null;
  shell_info: string | null;
  system_resources: string | null;
  package_manager: string | null;
  captured_at: string;
  vclock_json: string | null;
  deleted_at: string | null;
}

export interface SyncDiff {
  id: string;
  event_id: string;
  client_id: string;
  diff_text: string;
  file_filter: string | null;
  created_at: string;
}

export interface SyncBatch {
  tokenUsageRecords?: TokenUsageRecord[];
  sessions: SyncSession[];
  events: SyncEvent[];
  /** Kept in the wire shape for server compatibility; local snapshots are never uploaded. */
  envSnapshots: SyncEnvSnapshot[];
  diffs: SyncDiff[];
}

export interface BuildSyncBatchResult {
  batch: SyncBatch;
  /**
   * True when the diff byte cap trimmed trailing events from this batch.
   * The caller should keep looping even though the batch is smaller than
   * the batch size — the trimmed events are still unsynced.
   */
  diffByteCapApplied: boolean;
}

/**
 * Build a sync batch of records after the given cursor.
 *
 * Events are the only cursor-driving records. Each batch selects new events,
 * derives their unique parent sessions, then attaches every diff belonging to
 * those events. A session can never be uploaded without an event.
 */
export function buildSyncBatch(
  db: Database.Database,
  afterEventId: string | null,
  projectId: string,
  cloudClientId: string,
  batchSize: number,
): BuildSyncBatchResult {
  const batch: SyncBatch = {
    sessions: [],
    events: [],
    envSnapshots: [],
    diffs: [],
  };

  // 1. Events — append-only, only new records. Trim the suffix until the
  //    server-counted records (events + unique parent sessions) fit. A single
  //    event is always retained so very small configured limits still make
  //    progress with its required parent.
  batch.events = queryEvents(
    db,
    afterEventId,
    projectId,
    cloudClientId,
    Math.max(1, batchSize),
  );
  while (
    batch.events.length > 1 &&
    batch.events.length + uniqueSessionIds(batch.events).length > batchSize
  ) {
    batch.events.pop();
  }

  // 2. Diffs — keyed by event_id, only for events in this batch.
  //    Diffs are exempt from the record-count budget: an event whose diffs
  //    were dropped never retries them (the cursor moves past the event),
  //    so every shipped event must carry ALL of its diffs. Payload size is
  //    bounded by the byte cap, which trims trailing EVENTS (not just
  //    diffs) so trimmed events stay before the cursor and retry next
  //    batch. Count stays bounded in practice (≤1 diff per assistant turn)
  //    and the server does not enforce a per-push record limit.
  let diffByteCapApplied = false;
  if (batch.events.length > 0) {
    const eventIds = batch.events.map((e) => e.id);
    const allDiffs = queryDiffs(db, eventIds, cloudClientId);
    diffByteCapApplied = applyDiffByteCap(batch, allDiffs, MAX_SYNC_DIFF_BYTES);
  }

  // 3. Sessions — the unique parents of the final event set. This happens
  //    after diff trimming so no parent-only session can remain in the batch.
  batch.sessions = querySessionsByIds(
    db,
    uniqueSessionIds(batch.events),
    projectId,
    cloudClientId,
  );

  return { batch, diffByteCapApplied };
}

const DIFF_TRUNCATION_MARKER = "\n… [truncated by adit sync: diff exceeds batch byte cap]";

/**
 * Attach diffs to the batch while keeping total diff_text bytes under the
 * cap. Events are trimmed as a suffix so every shipped event carries all of
 * its diffs. If the very first event's diffs alone exceed the cap, its
 * diff_text is truncated (with a marker) so the batch always makes progress.
 *
 * Returns true when trailing events were trimmed (caller should keep
 * looping even though the batch is smaller than the batch size).
 */
function applyDiffByteCap(
  batch: SyncBatch,
  diffs: SyncDiff[],
  cap: number,
): boolean {
  if (diffs.length === 0) {
    batch.diffs = [];
    return false;
  }

  const diffsByEvent = new Map<string, SyncDiff[]>();
  for (const diff of diffs) {
    const list = diffsByEvent.get(diff.event_id);
    if (list) {
      list.push(diff);
    } else {
      diffsByEvent.set(diff.event_id, [diff]);
    }
  }

  const keptDiffs: SyncDiff[] = [];
  let total = 0;
  let cutIndex = batch.events.length;

  for (let i = 0; i < batch.events.length; i++) {
    const eventDiffs = diffsByEvent.get(batch.events[i].id) ?? [];
    // Real UTF-8 bytes: String.length counts UTF-16 code units and undercounts
    // CJK/emoji up to 3x, which is exactly how oversized payloads slipped past
    // this cap and hit the server's request-size limit.
    const size = eventDiffs.reduce((sum, d) => sum + utf8ByteLength(d.diff_text), 0);

    if (total + size > cap) {
      if (i === 0) {
        // A single event's diffs exceed the cap on their own. Truncate the
        // diff text so this event still ships — otherwise the sync would
        // stall on it forever.
        let budget = cap;
        for (const diff of eventDiffs) {
          if (utf8ByteLength(diff.diff_text) > budget) {
            diff.diff_text =
              truncateToUtf8Bytes(
                diff.diff_text,
                Math.max(0, budget - utf8ByteLength(DIFF_TRUNCATION_MARKER)),
              ) + DIFF_TRUNCATION_MARKER;
          }
          budget = Math.max(0, budget - utf8ByteLength(diff.diff_text));
          keptDiffs.push(diff);
        }
        cutIndex = 1;
      } else {
        cutIndex = i;
      }
      break;
    }

    total += size;
    keptDiffs.push(...eventDiffs);
  }

  const trimmed = cutIndex < batch.events.length;
  if (trimmed) {
    batch.events = batch.events.slice(0, cutIndex);
  }
  batch.diffs = keptDiffs;
  return trimmed;
}

/**
 * Count unsynced events for a project.
 *
 * Used by auto-sync's count-based trigger: only events count toward the
 * threshold — session records and diffs ride along in the batch once a sync
 * is triggered. Environment snapshots always remain local.
 */
export function countUnsyncedEvents(
  db: Database.Database,
  afterEventId: string | null,
  projectId: string,
): number {
  if (afterEventId) {
    const row = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM events e
         JOIN sessions s ON e.session_id = s.id
         WHERE e.id > ? AND s.project_id = ?`,
      )
      .get(afterEventId, projectId) as { cnt: number };
    return row.cnt;
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM events e
       JOIN sessions s ON e.session_id = s.id
       WHERE s.project_id = ?`,
    )
    .get(projectId) as { cnt: number };
  return row.cnt;
}

/** Get total record count in a batch */
export function batchRecordCount(batch: SyncBatch): number {
  return (
    batch.sessions.length +
    batch.events.length +
    batch.envSnapshots.length +
    (batch.tokenUsageRecords?.length ?? 0)
  );
}

// --- Internal query helpers ---

function uniqueSessionIds(events: SyncEvent[]): string[] {
  return Array.from(new Set(events.map((event) => event.session_id)));
}

export function querySessionsByIds(
  db: Database.Database,
  sessionIds: string[],
  projectId: string,
  cloudClientId: string,
): SyncSession[] {
  if (sessionIds.length === 0) return [];
  const placeholders = sessionIds.map(() => "?").join(",");
  const sql = `SELECT * FROM sessions
               WHERE project_id = ? AND id IN (${placeholders})
               ORDER BY id ASC`;

  const rows = db.prepare(sql).all(projectId, ...sessionIds) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as string,
    project_id: r.project_id as string,
    client_id: cloudClientId,
    session_type: r.session_type as string,
    platform: r.platform as string,
    started_at: r.started_at as string,
    metadata_json: (r.metadata_json as string) ?? null,
    vclock_json: (r.vclock_json as string) ?? null,
    deleted_at: (r.deleted_at as string) ?? null,
  }));
}

function queryEvents(
  db: Database.Database,
  afterId: string | null,
  projectId: string,
  cloudClientId: string,
  limit: number,
): SyncEvent[] {
  let sql: string;
  const params: unknown[] = [];

  if (afterId) {
    const conditions = ["e.id > ?", "s.project_id = ?"];
    params.push(afterId, projectId);
    sql = `SELECT e.* FROM events e
           JOIN sessions s ON e.session_id = s.id
           WHERE ${conditions.join(" AND ")}
           ORDER BY e.id ASC LIMIT ?`;
  } else {
    const conditions = ["s.project_id = ?"];
    params.push(projectId);
    sql = `SELECT e.* FROM events e
           JOIN sessions s ON e.session_id = s.id
           WHERE ${conditions.join(" AND ")}
           ORDER BY e.id ASC LIMIT ?`;
  }
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as string,
    session_id: r.session_id as string,
    client_id: cloudClientId,
    parent_event_id: (r.parent_event_id as string) ?? null,
    sequence: r.sequence as number,
    event_type: r.event_type as string,
    actor: r.actor as string,
    status: r.status as string,
    prompt_text: (r.prompt_text as string) ?? null,
    cot_text: (r.cot_text as string) ?? null,
    response_text: (r.response_text as string) ?? null,
    tool_name: (r.tool_name as string) ?? null,
    tool_input_json: (r.tool_input_json as string) ?? null,
    tool_output_json: (r.tool_output_json as string) ?? null,
    diff_stat_json: (r.diff_stat_json as string) ?? null,
    git_branch: (r.git_branch as string) ?? null,
    git_head_sha: (r.git_head_sha as string) ?? null,
    env_snapshot_id: (r.env_snapshot_id as string) ?? null,
    started_at: r.started_at as string,
    ended_at: (r.ended_at as string) ?? null,
    error_json: (r.error_json as string) ?? null,
    labels_json: (r.labels_json as string) ?? null,
    vclock_json: (r.vclock_json as string) ?? null,
    deleted_at: (r.deleted_at as string) ?? null,
  }));
}

function queryDiffs(
  db: Database.Database,
  eventIds: string[],
  cloudClientId: string,
): SyncDiff[] {
  if (eventIds.length === 0) return [];

  // No LIMIT: every diff belonging to a shipped event must ship with it
  // (see the diff exemption note in buildSyncBatch). An arbitrary cutoff
  // here would orphan the excess diffs permanently.
  const placeholders = eventIds.map(() => "?").join(",");
  const sql = `SELECT * FROM diffs WHERE event_id IN (${placeholders}) ORDER BY event_id ASC`;

  const rows = db
    .prepare(sql)
    .all(...eventIds) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as string,
    event_id: r.event_id as string,
    client_id: cloudClientId,
    diff_text: r.diff_text as string,
    file_filter: (r.file_filter as string) ?? null,
    created_at: r.created_at as string,
  }));
}
