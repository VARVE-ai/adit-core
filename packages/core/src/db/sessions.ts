/**
 * Session CRUD operations.
 */

import type Database from "better-sqlite3";
import type { AditSession, SessionStatus, Platform, SessionType } from "../types/index.js";

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

export function getActiveSession(
  db: Database.Database,
  projectId: string,
  clientId: string,
  platform?: Platform,
): AditSession | null {
  // Optional platform filter keeps sessionless hook events (no platform
  // session id in the payload) from attaching to another CLI's session.
  const row = db
    .prepare(
      `SELECT * FROM sessions WHERE project_id = ? AND client_id = ? AND status = 'active' AND deleted_at IS NULL${platform ? " AND platform = ?" : ""} ORDER BY started_at DESC LIMIT 1`,
    )
    .get(...(platform ? [projectId, clientId, platform] : [projectId, clientId])) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToSession(row) : null;
}

/**
 * Close active sessions whose last activity is older than the cutoff.
 *
 * "Last activity" is the newest event's started_at, falling back to the
 * session's own started_at for sessions with no events. Scoped to one
 * project+platform because this backstops platforms without a SessionEnd
 * hook event (Codex has none), where sessions would otherwise stay active
 * forever. Returns the number of sessions closed.
 */
export function endStaleSessions(
  db: Database.Database,
  input: {
    projectId: string;
    platform: Platform;
    cutoffIso: string;
    excludeSessionId?: string;
  },
): number {
  const result = db
    .prepare(
      `UPDATE sessions SET ended_at = ?, status = 'completed'
       WHERE project_id = ? AND platform = ? AND status = 'active' AND deleted_at IS NULL
         AND id != ?
         AND COALESCE(
           (SELECT MAX(e.started_at) FROM events e WHERE e.session_id = sessions.id AND e.deleted_at IS NULL),
           sessions.started_at
         ) < ?`,
    )
    .run(
      new Date().toISOString(),
      input.projectId,
      input.platform,
      input.excludeSessionId ?? "",
      input.cutoffIso,
    );
  return result.changes;
}

export function getSessionByPlatformSessionId(
  db: Database.Database,
  platformSessionId: string,
): AditSession | null {
  const row = db
    .prepare(
      "SELECT * FROM sessions WHERE platform_session_id = ? AND status = 'active' AND deleted_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .get(platformSessionId) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

export function endSession(
  db: Database.Database,
  id: string,
  status: SessionStatus = "completed",
  vclockJson?: string,
): void {
  const now = new Date().toISOString();
  if (vclockJson) {
    db.prepare(
      "UPDATE sessions SET ended_at = ?, status = ?, vclock_json = ? WHERE id = ?",
    ).run(now, status, vclockJson, id);
  } else {
    db.prepare(
      "UPDATE sessions SET ended_at = ?, status = ? WHERE id = ?",
    ).run(now, status, id);
  }
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
    endedAt: (row.ended_at as string) ?? null,
    status: row.status as SessionStatus,
    metadataJson: (row.metadata_json as string) ?? null,
    vclockJson: row.vclock_json as string,
    platformSessionId: (row.platform_session_id as string) ?? null,
    deletedAt: (row.deleted_at as string) ?? null,
  };
}
