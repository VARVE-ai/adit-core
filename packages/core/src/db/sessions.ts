/**
 * Session CRUD operations.
 */

import type Database from "better-sqlite3";
import type { AditSession, Platform, SessionType } from "../types/index.js";

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
  return row ? rowToSession(row) : null;
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
