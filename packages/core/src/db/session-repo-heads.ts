/**
 * Per-session per-repository HEAD baselines.
 *
 * Records the last HEAD sha a session observed for each repository
 * (relativePath "." for repo projects, child paths for workspaces).
 * Hook handlers compare the current HEAD against this baseline to
 * detect commits that happened during the session and attribute them
 * via git_commit events.
 */

import type Database from "better-sqlite3";

export interface SessionRepoHead {
  sessionId: string;
  relativePath: string;
  lastSha: string;
  updatedAt: string;
}

/** Get all repo HEAD baselines for a session */
export function getSessionRepoHeads(
  db: Database.Database,
  sessionId: string,
): SessionRepoHead[] {
  const rows = db
    .prepare("SELECT * FROM session_repo_heads WHERE session_id = ?")
    .all(sessionId) as Record<string, unknown>[];

  return rows.map((row) => ({
    sessionId: row.session_id as string,
    relativePath: row.relative_path as string,
    lastSha: row.last_sha as string,
    updatedAt: row.updated_at as string,
  }));
}

/** Insert or update the HEAD baseline for one session/repo pair */
export function upsertSessionRepoHead(
  db: Database.Database,
  entry: { sessionId: string; relativePath: string; lastSha: string },
): void {
  db.prepare(
    `INSERT INTO session_repo_heads (session_id, relative_path, last_sha, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (session_id, relative_path) DO UPDATE SET
       last_sha = excluded.last_sha,
       updated_at = excluded.updated_at`,
  ).run(entry.sessionId, entry.relativePath, entry.lastSha, new Date().toISOString());
}
