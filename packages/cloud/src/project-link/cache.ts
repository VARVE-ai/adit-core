/**
 * Local SQLite cache for project link state.
 *
 * Tracks the server-confirmed project ID, Git ref heads, and
 * document content hashes. Stored in the
 * shared local.sqlite database.
 */

import type Database from "better-sqlite3";
import { normalizeServerUrl } from "@varveai/adit-core";
import type { ProjectLinkCache } from "./types.js";

export function ensureProjectLinkCache(db:Database.Database):void {
 db.exec(`CREATE TABLE IF NOT EXISTS adit_local_cloud_link_cache (
 project_id TEXT NOT NULL, repository_id TEXT NOT NULL, server_url TEXT NOT NULL,
 confirmed_project_id TEXT, git_ref_heads_json TEXT NOT NULL DEFAULT '{}',git_refs_fingerprint TEXT,
 remote_refs_fingerprint TEXT,last_remote_branch_check_at TEXT,last_branch_sync_at TEXT,last_doc_sync_at TEXT,
 doc_hashes_json TEXT NOT NULL DEFAULT '{}',initialized_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(project_id,repository_id,server_url));`);
}

/** Row shape from the adit_local_cloud_link_cache table */
interface CacheRow {
  project_id: string;
  repository_id: string;
  server_url: string;
  confirmed_project_id: string | null;
  git_ref_heads_json: string;
  git_refs_fingerprint: string | null;
  remote_refs_fingerprint: string | null;
  last_remote_branch_check_at: string | null;
  last_branch_sync_at: string | null;
  last_doc_sync_at: string | null;
  doc_hashes_json: string;
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
  ensureProjectLinkCache(db);
  const row = db
    .prepare(
      "SELECT * FROM adit_local_cloud_link_cache WHERE project_id = ? AND repository_id = ? AND server_url = ?",
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
    remoteRefsFingerprint: row.remote_refs_fingerprint,
    lastRemoteBranchCheckAt: row.last_remote_branch_check_at,
    lastBranchSyncAt: row.last_branch_sync_at,
    lastDocSyncAt: row.last_doc_sync_at,
    docHashes,
    initializedAt: row.initialized_at,
    updatedAt: row.updated_at,
  };
}

/** Create or update project link cache */
export function upsertProjectLinkCache(
  db: Database.Database,
  cache: ProjectLinkCache,
): void {
  ensureProjectLinkCache(db);
  db.prepare(`
    INSERT INTO adit_local_cloud_link_cache (
      project_id, repository_id, server_url, confirmed_project_id,
      git_ref_heads_json, git_refs_fingerprint,
      remote_refs_fingerprint, last_remote_branch_check_at,
      last_branch_sync_at, last_doc_sync_at,
      doc_hashes_json, initialized_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (project_id, repository_id, server_url) DO UPDATE SET
      confirmed_project_id = excluded.confirmed_project_id,
      git_ref_heads_json = excluded.git_ref_heads_json,
      git_refs_fingerprint = excluded.git_refs_fingerprint,
      remote_refs_fingerprint = excluded.remote_refs_fingerprint,
      last_remote_branch_check_at = excluded.last_remote_branch_check_at,
      last_branch_sync_at = excluded.last_branch_sync_at,
      last_doc_sync_at = excluded.last_doc_sync_at,
      doc_hashes_json = excluded.doc_hashes_json,
      updated_at = excluded.updated_at
  `).run(
    cache.projectId,
    cache.repositoryId,
    normalizeServerUrl(cache.serverUrl),
    cache.confirmedProjectId,
    JSON.stringify(cache.gitRefHeads),
    cache.gitRefsFingerprint,
    cache.remoteRefsFingerprint,
    cache.lastRemoteBranchCheckAt,
    cache.lastBranchSyncAt,
    cache.lastDocSyncAt,
    JSON.stringify(cache.docHashes),
    cache.initializedAt,
    cache.updatedAt,
  );
}

/** Persist the last successful authoritative origin branch read. */
export function updateCachedRemoteBranchState(
  db: Database.Database,
  projectId: string,
  serverUrl: string,
  state: {
    refsFingerprint: string;
    checkedAt?: string;
  },
  repositoryId = projectId,
): void {
  ensureProjectLinkCache(db);
  const checkedAt = state.checkedAt ?? new Date().toISOString();
  db.prepare(`
    UPDATE adit_local_cloud_link_cache
    SET remote_refs_fingerprint = ?, last_remote_branch_check_at = ?, updated_at = ?
    WHERE project_id = ? AND repository_id = ? AND server_url = ?
  `).run(
    state.refsFingerprint,
    checkedAt,
    checkedAt,
    projectId,
    repositoryId,
    normalizeServerUrl(serverUrl),
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
  ensureProjectLinkCache(db);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE adit_local_cloud_link_cache
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
  ensureProjectLinkCache(db);
  if (repositoryId) {
    db.prepare(
      "DELETE FROM adit_local_cloud_link_cache WHERE project_id = ? AND repository_id = ? AND server_url = ?",
    ).run(projectId, repositoryId, normalizeServerUrl(serverUrl));
    return;
  }

  db.prepare("DELETE FROM adit_local_cloud_link_cache WHERE project_id = ? AND server_url = ?")
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
  ensureProjectLinkCache(db);
  db.prepare(`
    UPDATE adit_local_cloud_link_cache
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
