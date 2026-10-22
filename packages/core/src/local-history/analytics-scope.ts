import type Database from "better-sqlite3";
import type { LocalWorkspace } from "../local-state.js";
import { insideDirectory } from "./sources.js";
import { projectSessionLocations } from "../local-projects.js";
import { resolve } from "node:path";
import { conversationScope } from "./session-identity.js";
export function analyticsSessions(
  db: Database.Database,
  workspace: LocalWorkspace,
) {
  const locations = projectSessionLocations(db,workspace);
  return conversationScope((
    db
      .prepare(
        `SELECT s.provider,s.id,s.parent_id,s.relationship,s.started_at,s.last_activity_at,s.transcript_revision,
    coalesce(nullif(s.cwd,''),a.workspace,'') AS cwd FROM adit_history_sessions s
    LEFT JOIN adit_history_assignments a ON a.provider=s.provider AND a.session_id=s.id`,
      )
      .all() as {
      provider: string;
      id: string;
      parent_id: string | null;
      relationship: string | null;
      started_at: number | null;
      last_activity_at: number | null;
      transcript_revision: number;
      cwd: string;
    }[]
  ).map(s => {
    const saved = locations.get(`${s.provider}\0${s.id}`);
    return saved && !insideDirectory(workspace.path,s.cwd) ? {...s,cwd:resolve(workspace.path,saved.relative_cwd)} : s;
  }).filter(
    (s) =>
      (workspace.providers.includes(s.provider) ||
        ["claude-ai", "chatgpt", "gemini-apps"].includes(s.provider)) &&
      s.cwd &&
      insideDirectory(workspace.path, s.cwd),
  ));
}
