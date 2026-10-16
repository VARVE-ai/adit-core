import type Database from "better-sqlite3";
import { normalizeServerUrl } from "@varveai/adit-core";
import { querySessionsByIds, serializeEvent, type SyncBatch, type SyncEvent } from "./serializer.js";

interface UsageSyncScope {
  projectId: string;
  serverUrl: string;
  cloudClientId: string;
}

function acknowledgementKey(scope: UsageSyncScope): string {
  return JSON.stringify([normalizeServerUrl(scope.serverUrl), scope.cloudClientId]);
}

function pendingEvents(db: Database.Database, scope: UsageSyncScope, limit: number) {
  return db.prepare(`SELECT event.* FROM events event JOIN sessions session ON session.id = event.session_id
    WHERE session.project_id = ? AND session.deleted_at IS NULL AND event.deleted_at IS NULL
      AND event.token_usage_json IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM json_each(COALESCE(event.token_usage_ack_json, '{}')) ack
        WHERE ack.key = ? AND ack.value >= event.token_usage_revision)
    ORDER BY event.id LIMIT ?`).all(scope.projectId, acknowledgementKey(scope), limit) as Record<string, unknown>[];
}

export function hasPendingTokenUsage(db: Database.Database, scope: UsageSyncScope): boolean {
  return pendingEvents(db, scope, 1).length > 0;
}

export interface UsageSyncAcknowledgement {
  accepted: number;
  duplicates: number;
  eventTokenUsageAcknowledgements?: { id: string; revision: number }[];
}

export function acknowledgeEventTokenUsage(db: Database.Database, events: SyncEvent[], response: UsageSyncAcknowledgement, scope: UsageSyncScope): void {
  const expected = events.filter(event => event.tokenUsage);
  if (!expected.length) return;
  const acknowledgements = new Map(response.eventTokenUsageAcknowledgements?.map(record => [record.id, record.revision]));
  if (expected.some(event => acknowledgements.get(event.id) !== event.tokenUsage!.revision)) {
    throw new Error("Cloud did not acknowledge reply token usage; update Cloud before syncing this CLI");
  }
  db.transaction(() => {
    for (const event of expected) {
      const row = db.prepare("SELECT token_usage_ack_json FROM events WHERE id = ?").get(event.id) as { token_usage_ack_json: string | null } | undefined;
      if (!row) continue;
      const state = JSON.parse(row.token_usage_ack_json ?? "{}") as Record<string, number>;
      const key = acknowledgementKey(scope);
      state[key] = Math.max(state[key] ?? 0, event.tokenUsage!.revision);
      db.prepare("UPDATE events SET token_usage_ack_json = ? WHERE id = ?").run(JSON.stringify(state), event.id);
    }
  })();
}

export async function syncTokenUsage(db: Database.Database, push: (batch: SyncBatch) => Promise<UsageSyncAcknowledgement>, scope: UsageSyncScope) {
  const result = { accepted: 0, duplicates: 0, batches: 0, totalRecords: 0 };
  while (true) {
    const rows = pendingEvents(db, scope, 100);
    if (!rows.length) return result;
    let events = rows.map(row => serializeEvent(row, scope.cloudClientId));
    while (events.length > 1 && Buffer.byteLength(JSON.stringify(events), "utf8") > 4 * 1024 * 1024) {
      events = events.slice(0, Math.ceil(events.length / 2));
    }
    const sessions = querySessionsByIds(db, [...new Set(events.map(event => event.session_id))], scope.projectId, scope.cloudClientId);
    const response = await push({ sessions, events, envSnapshots: [], diffs: [] });
    acknowledgeEventTokenUsage(db, events, response, scope);
    result.accepted += response.accepted;
    result.duplicates += response.duplicates;
    result.batches++;
    result.totalRecords += events.length + sessions.length;
  }
}
