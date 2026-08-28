/**
 * Local SQLite cache for project link state.
 *
 * Tracks the server-confirmed project ID, Git ref heads,
 * document content hashes, and qualification status. Stored in the
 * existing adit database ($projectRoot/.adit/adit.sqlite).
 */

import type Database from "better-sqlite3";
import { normalizeServerUrl } from "@varveai/adit-core";
import type { ProjectLinkCache } from "./types.js";

/** Row shape from the project_link_cache table */
interface CacheRow {
  project_id: string;
  repository_id: string;
  server_url: string;
  confirmed_project_id: string | null;
  git_ref_heads_json: string;
  git_refs_fingerprint: string | null;
  last_branch_sync_at: string | null;
  last_doc_sync_at: string | null;
  doc_hashes_json: string;
  qualified: number;
  initialized_at: string;
  updated_at: string;
}

const LEGACY_REFS_FINGERPRINT_KEY = "__adit_git_refs_fingerprint";

/** Get cached state for a project link */
export function getProjectLinkCache(
  db: Database.Database,
  projectId: string,
  serverUrl: string,
  repositoryId = projectId,
): ProjectLinkCache | null {
  const row = db
    .prepare(
      "SELECT * FROM project_link_cache WHERE project_id = ? AND repository_id = ? AND server_url = ?",
    )
    .get(
      projectId,
      repositoryId,
      normalizeServerUrl(serverUrl),
    ) as CacheRow | undefined;

  if (!row) return null;

  let docHashes: Record<string, string> = {};
  try {
    docHashes = JSON.parse(row.doc_hashes_json) as Record<string, string>;
  } catch {
    // Corrupted JSON — treat as empty (documents will be re-uploaded)
  }

  let gitRefHeads: Record<string, string> = {};
  try {
    gitRefHeads = JSON.parse(row.git_ref_heads_json) as Record<string, string>;
  } catch {
    // Corrupted JSON — the next git sync will rebuild the baseline.
  }

  const legacyRefsFingerprint = typeof docHashes[LEGACY_REFS_FINGERPRINT_KEY] === "string"
    ? docHashes[LEGACY_REFS_FINGERPRINT_KEY]
    : null;
  delete docHashes[LEGACY_REFS_FINGERPRINT_KEY];

  return {
    projectId: row.project_id,
    repositoryId: row.repository_id,
    serverUrl: row.server_url,
    confirmedProjectId: row.confirmed_project_id,
    gitRefHeads,
    gitRefsFingerprint: row.git_refs_fingerprint ?? legacyRefsFingerprint,
    lastBranchSyncAt: row.last_branch_sync_at,
    lastDocSyncAt: row.last_doc_sync_at,
    docHashes,
    qualified: row.qualified === 1,
    initializedAt: row.initialized_at,
    updatedAt: row.updated_at,
  };
}

/** Create or update project link cache */
export function upsertProjectLinkCache(
  db: Database.Database,
  cache: ProjectLinkCache,
): void {
  db.prepare(`
    INSERT INTO project_link_cache (
      project_id, repository_id, server_url, confirmed_project_id,
      git_ref_heads_json, git_refs_fingerprint,
      last_branch_sync_at, last_doc_sync_at,
      doc_hashes_json, qualified, initialized_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (project_id, repository_id, server_url) DO UPDATE SET
      confirmed_project_id = excluded.confirmed_project_id,
      git_ref_heads_json = excluded.git_ref_heads_json,
      git_refs_fingerprint = excluded.git_refs_fingerprint,
      last_branch_sync_at = excluded.last_branch_sync_at,
      last_doc_sync_at = excluded.last_doc_sync_at,
      doc_hashes_json = excluded.doc_hashes_json,
      qualified = excluded.qualified,
      updated_at = excluded.updated_at
  `).run(
    cache.projectId,
    cache.repositoryId,
    normalizeServerUrl(cache.serverUrl),
    cache.confirmedProjectId,
    JSON.stringify(cache.gitRefHeads),
    cache.gitRefsFingerprint,
    cache.lastBranchSyncAt,
    cache.lastDocSyncAt,
    JSON.stringify(cache.docHashes),
    cache.qualified ? 1 : 0,
    cache.initializedAt,
    cache.updatedAt,
  );
}

/** Persist git progress only after branches and commits have both uploaded. */
export function updateCachedGitState(
  db: Database.Database,
  projectId: string,
  serverUrl: string,
  state: {
    refHeads: Record<string, string>;
    refsFingerprint: string;
  },
  repositoryId = projectId,
): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE project_link_cache
    SET git_ref_heads_json = ?, git_refs_fingerprint = ?,
        last_branch_sync_at = ?, updated_at = ?
    WHERE project_id = ? AND repository_id = ? AND server_url = ?
  `).run(
    JSON.stringify(state.refHeads),
    state.refsFingerprint,
    now,
    now,
    projectId,
    repositoryId,
    normalizeServerUrl(serverUrl),
  );
}

/** Clear cache for a project link (used by --force) */
export function clearProjectLinkCache(
  db: Database.Database,
  projectId: string,
  serverUrl: string,
  repositoryId?: string,
): void {
  if (repositoryId) {
    db.prepare(
      "DELETE FROM project_link_cache WHERE project_id = ? AND repository_id = ? AND server_url = ?",
    ).run(projectId, repositoryId, normalizeServerUrl(serverUrl));
    return;
  }

  db.prepare("DELETE FROM project_link_cache WHERE project_id = ? AND server_url = ?")
    .run(projectId, normalizeServerUrl(serverUrl));
}

/** Update cached document hashes after upload */
export function updateCachedDocHashes(
  db: Database.Database,
  projectId: string,
  serverUrl: string,
  hashes: Record<string, string>,
  repositoryId = projectId,
): void {
  db.prepare(`
    UPDATE project_link_cache
    SET doc_hashes_json = ?, last_doc_sync_at = ?, updated_at = ?
    WHERE project_id = ? AND repository_id = ? AND server_url = ?
  `).run(
    JSON.stringify(hashes),
    new Date().toISOString(),
    new Date().toISOString(),
    projectId,
    repositoryId,
    normalizeServerUrl(serverUrl),
  );
}

/** Mark as qualified or not */
export function updateCachedQualified(
  db: Database.Database,
  projectId: string,
  serverUrl: string,
  qualified: boolean,
  repositoryId = projectId,
): void {
  db.prepare(`
    UPDATE project_link_cache
    SET qualified = ?, updated_at = ?
    WHERE project_id = ? AND repository_id = ? AND server_url = ?
  `).run(
    qualified ? 1 : 0,
    new Date().toISOString(),
    projectId,
    repositoryId,
    normalizeServerUrl(serverUrl),
  );
}
