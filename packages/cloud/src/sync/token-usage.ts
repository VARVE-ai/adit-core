import type Database from "better-sqlite3";
import { normalizeServerUrl, type TokenUsageRecord } from "@varveai/adit-core";
import { querySessionsByIds, type SyncBatch } from "./serializer.js";

interface UsageSyncScope {
  projectId: string;
  serverUrl: string;
  cloudClientId: string;
}

const pendingUsage = `
  FROM token_usage_records AS usage
  JOIN sessions AS session ON session.id = usage.session_id
  LEFT JOIN token_usage_sync_state AS synced ON synced.record_id = usage.id
    AND synced.server_url = ? AND synced.client_id = ?
  WHERE session.project_id = ? AND session.deleted_at IS NULL
    AND (synced.revision IS NULL OR synced.revision < usage.revision)`;

export function hasPendingTokenUsage(db: Database.Database, scope: UsageSyncScope): boolean {
  return Boolean(db.prepare(`SELECT 1 ${pendingUsage} LIMIT 1`)
    .get(normalizeServerUrl(scope.serverUrl), scope.cloudClientId, scope.projectId));
}

export interface UsageSyncAcknowledgement {
  accepted: number;
  duplicates: number;
  tokenUsageAcknowledgements?: { id: string; revision: number }[];
}

export async function syncTokenUsage(
  db: Database.Database, push: (batch: SyncBatch) => Promise<UsageSyncAcknowledgement>, scope: UsageSyncScope,
): Promise<{ accepted: number; duplicates: number; batches: number; totalRecords: number }> {
  const result = { accepted: 0, duplicates: 0, batches: 0, totalRecords: 0 };
  const serverUrl = normalizeServerUrl(scope.serverUrl);
  while (true) {
    const rows = db.prepare(`SELECT usage.id, usage.revision, usage.record_json ${pendingUsage}
      ORDER BY usage.id LIMIT 100`).all(serverUrl, scope.cloudClientId, scope.projectId) as {
        id: string; revision: number; record_json: string;
      }[];
    if (!rows.length) return result;
    const records = rows.map((row) => JSON.parse(row.record_json) as TokenUsageRecord);
    const sessions = querySessionsByIds(db, [...new Set(records.map((record) => record.sessionId))], scope.projectId, scope.cloudClientId);
    const response = await push({
      sessions,
      events: [], envSnapshots: [], diffs: [], tokenUsageRecords: records,
    });
    const acknowledgements = new Map(response.tokenUsageAcknowledgements?.map((record) => [record.id, record.revision]));
    if (acknowledgements.size !== rows.length || rows.some((row) => acknowledgements.get(row.id) !== row.revision)) {
      throw new Error("Cloud did not acknowledge the token usage batch");
    }
    db.transaction(() => {
      const acknowledge = db.prepare(`INSERT INTO token_usage_sync_state (server_url, client_id, record_id, revision)
        SELECT ?, ?, id, ? FROM token_usage_records WHERE id = ?
        ON CONFLICT(server_url, client_id, record_id) DO UPDATE SET revision = MAX(revision, excluded.revision)`);
      for (const row of rows) acknowledge.run(serverUrl, scope.cloudClientId, row.revision, row.id);
    })();
    result.accepted += response.accepted;
    result.duplicates += response.duplicates;
    result.batches++;
    result.totalRecords += rows.length + sessions.length;
  }
}
