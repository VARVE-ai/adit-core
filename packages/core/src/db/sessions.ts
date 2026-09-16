/**
 * Session CRUD operations.
 */

import type Database from "better-sqlite3";
import type { AditSession, Platform, SessionType } from "../types/index.js";
import { deserialize, serialize, tick } from "../sync/vclock.js";

export interface CreateSessionInput {
  id: string;
  projectId: string;
  clientId: string;
  sessionType: SessionType;
  platform: Platform;
  startedAt: string;
  metadataJson?: string | null;
  vclockJson: string;
  platformSessionId?: string | null;
}

export function insertSession(
  db: Database.Database,
  input: CreateSessionInput,
): void {
  db.prepare(`
    INSERT INTO sessions (id, project_id, client_id, session_type, platform, started_at, metadata_json, vclock_json, platform_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.projectId,
    input.clientId,
    input.sessionType,
    input.platform,
    input.startedAt,
    input.metadataJson ?? null,
    input.vclockJson,
    input.platformSessionId ?? null,
  );
}

export function getSessionById(
  db: Database.Database,
  id: string,
): AditSession | null {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToSession(row) : null;
}

/** Return the session with the most recent recorded activity. */
export function getLatestSession(
  db: Database.Database,
  projectId: string,
  clientId: string,
  platform?: Platform,
): AditSession | null {
  const row = db
    .prepare(
      `SELECT * FROM sessions
       WHERE project_id = ? AND client_id = ? AND deleted_at IS NULL${platform ? " AND platform = ?" : ""}
       ORDER BY COALESCE(
         (SELECT MAX(e.started_at) FROM events e WHERE e.session_id = sessions.id AND e.deleted_at IS NULL),
         sessions.started_at
       ) DESC, sessions.started_at DESC
       LIMIT 1`,
    )
    .get(...(platform ? [projectId, clientId, platform] : [projectId, clientId])) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToSession(row) : null;
}

export function getSessionByPlatformSessionId(
  db: Database.Database,
  platformSessionId: string,
): AditSession | null {
  // A platform session id is the only reliable identity. Historical databases
  // may contain duplicate rows from the retired lifecycle/revival logic, so
  // prefer the newest row without trying to infer an active state.
  const row = db
    .prepare(
      `SELECT * FROM sessions WHERE platform_session_id = ? AND deleted_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(platformSessionId) as Record<string, unknown> | undefined;
  if (row) return rowToSession(row);

  // A platform session id attached later as an alias (client-side fork of an
  // existing conversation) resolves to the session it was attached to.
  const aliased = db
    .prepare(
      `SELECT s.* FROM session_platform_aliases a
       JOIN sessions s ON s.id = a.session_id
       WHERE a.platform_session_id = ? AND s.deleted_at IS NULL
       LIMIT 1`,
    )
    .get(platformSessionId) as Record<string, unknown> | undefined;
  return aliased ? rowToSession(aliased) : null;
}

/**
 * Attach an additional platform session id to an existing local session, so
 * hooks arriving under that id keep recording into the same conversation.
 */
export function insertSessionPlatformAlias(
  db: Database.Database,
  input: { platformSessionId: string; sessionId: string; createdAt?: string },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO session_platform_aliases (platform_session_id, session_id, created_at)
     VALUES (?, ?, ?)`,
  ).run(input.platformSessionId, input.sessionId, input.createdAt ?? new Date().toISOString());
}

/** Platform session ids attached to a session as aliases (oldest first). */
export function listSessionPlatformAliases(
  db: Database.Database,
  sessionId: string,
): string[] {
  const rows = db
    .prepare(
      "SELECT platform_session_id FROM session_platform_aliases WHERE session_id = ? ORDER BY created_at ASC",
    )
    .all(sessionId) as Array<{ platform_session_id: string }>;
  return rows.map((row) => row.platform_session_id);
}

/** Latest event time of a session, else its start time. */
const LAST_ACTIVITY_SQL = `COALESCE(
  (SELECT MAX(e.started_at) FROM events e WHERE e.session_id = sessions.id AND e.deleted_at IS NULL),
  sessions.started_at
)`;

/**
 * Sessions of a project active at or after `since`, most recently active
 * first. Activity is the latest event (else the start time), so a long-lived
 * conversation keeps qualifying for as long as it is still in use.
 */
export function listRecentSessions(
  db: Database.Database,
  input: { projectId: string; platform?: Platform; since: string; limit?: number },
): AditSession[] {
  const rows = db
    .prepare(
      `SELECT * FROM sessions
       WHERE project_id = ? AND deleted_at IS NULL${input.platform ? " AND platform = ?" : ""}
         AND ${LAST_ACTIVITY_SQL} >= ?
       ORDER BY ${LAST_ACTIVITY_SQL} DESC, started_at DESC LIMIT ?`,
    )
    .all(
      ...(input.platform
        ? [input.projectId, input.platform, input.since, input.limit ?? 50]
        : [input.projectId, input.since, input.limit ?? 50]),
    ) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/**
 * Fold `sourceSessionId` into `targetSessionId`: its events continue the
 * target's sequence in their original order, its environment snapshots move
 * with them, and the source row is soft-deleted. Every moved or deleted row
 * gets a clock tick so a peer that already saw it picks up the change. One
 * transaction; used when a session created for a platform session id turns
 * out to be a client-side fork of `targetSessionId`.
 */
export function mergeSessionInto(
  db: Database.Database,
  input: { sourceSessionId: string; targetSessionId: string; clientId: string; now?: string },
): { movedEvents: number } {
  return db.transaction(() => {
    const { max } = db
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS max FROM events WHERE session_id = ?")
      .get(input.targetSessionId) as { max: number };
    const rows = db
      .prepare("SELECT id, vclock_json FROM events WHERE session_id = ? ORDER BY sequence ASC")
      .all(input.sourceSessionId) as Array<{ id: string; vclock_json: string }>;
    const move = db.prepare(
      "UPDATE events SET session_id = ?, sequence = ?, vclock_json = ? WHERE id = ?",
    );
    rows.forEach((row, index) => {
      move.run(input.targetSessionId, max + index + 1, tickClock(row.vclock_json, input.clientId), row.id);
    });
    db.prepare("UPDATE env_snapshots SET session_id = ? WHERE session_id = ?").run(
      input.targetSessionId,
      input.sourceSessionId,
    );
    const source = db
      .prepare("SELECT vclock_json FROM sessions WHERE id = ?")
      .get(input.sourceSessionId) as { vclock_json: string } | undefined;
    if (source) {
      db.prepare("UPDATE sessions SET deleted_at = ?, vclock_json = ? WHERE id = ?").run(
        input.now ?? new Date().toISOString(),
        tickClock(source.vclock_json, input.clientId),
        input.sourceSessionId,
      );
    }
    return { movedEvents: rows.length };
  })();
}

function tickClock(vclockJson: string, clientId: string): string {
  return serialize(tick(deserialize(vclockJson), clientId));
}

export function listSessions(
  db: Database.Database,
  projectId: string,
  limit = 20,
): AditSession[] {
  const rows = db
    .prepare(
      "SELECT * FROM sessions WHERE project_id = ? AND deleted_at IS NULL ORDER BY started_at DESC LIMIT ?",
    )
    .all(projectId, limit) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

function rowToSession(row: Record<string, unknown>): AditSession {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    clientId: row.client_id as string,
    sessionType: row.session_type as SessionType,
    platform: row.platform as Platform,
    startedAt: row.started_at as string,
    metadataJson: (row.metadata_json as string) ?? null,
    vclockJson: row.vclock_json as string,
    platformSessionId: (row.platform_session_id as string) ?? null,
    deletedAt: (row.deleted_at as string) ?? null,
  };
}
