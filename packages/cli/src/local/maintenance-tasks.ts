import type Database from "better-sqlite3";
import { compactHistoryRaw } from "@varveai/adit-core";

export const maintenanceTasks = ["history-block-data-v1", "history-message-raw-v1"] as const;
export type MaintenanceTask = typeof maintenanceTasks[number];
export type MaintenanceProgress = {
  task: MaintenanceTask;
  status: "running" | "done" | "failed";
  cursor: number;
  upper_bound: number;
  scanned: number;
  cleared: number;
  skipped: number;
  bytes_removed: number;
  updated_at: number;
  error: string | null;
};

export function createMaintenanceSchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS adit_local_maintenance (
    task TEXT PRIMARY KEY, status TEXT NOT NULL, cursor INTEGER NOT NULL, upper_bound INTEGER NOT NULL,
    scanned INTEGER NOT NULL, cleared INTEGER NOT NULL, skipped INTEGER NOT NULL, bytes_removed INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, error TEXT
  )`);
}

export function runMaintenanceBatch(db: Database.Database, task: MaintenanceTask) {
  if (!maintenanceTasks.includes(task)) throw new Error("Unknown maintenance task");
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='adit_local_jobs'").get() &&
      db.prepare("SELECT 1 FROM adit_local_jobs WHERE json_extract(data,'$.status') IN ('queued','running') LIMIT 1").get())
    return { paused: true } as const;
  return db.transaction(() => {
    const rawTask = task === "history-message-raw-v1";
    const table = rawTask ? "adit_history_messages" : "adit_history_blocks";
    db.prepare(`INSERT OR IGNORE INTO adit_local_maintenance
      VALUES (?,'running',0,(SELECT coalesce(max(rowid),0) FROM ${table}),0,0,0,0,?,NULL)`).run(task, Date.now());
    db.prepare(`UPDATE adit_local_maintenance SET upper_bound=(SELECT coalesce(max(rowid),0) FROM ${table})
      WHERE task=? AND upper_bound<0`).run(task);
    const progress = db.prepare("SELECT * FROM adit_local_maintenance WHERE task=?").get(task) as MaintenanceProgress;
    if (progress.status === "done") return { progress };
    const rows = db.prepare(rawTask ? `SELECT rowid,id,
      CASE WHEN raw_content_paths_json IS NULL THEN octet_length(raw_json) END AS bytes,
      coalesce(octet_length(content_json),0) AS message_bytes FROM adit_history_messages
      WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 128` : `SELECT b.rowid,b.id,octet_length(b.data_json) AS bytes,
      coalesce(octet_length(m.content_json),0) AS message_bytes
      FROM adit_history_blocks b LEFT JOIN adit_history_messages m ON m.id=b.message_id
      WHERE b.rowid>? AND b.rowid<=? ORDER BY b.rowid LIMIT 128`).all(progress.cursor, progress.upper_bound) as {
        rowid: number; id: string; bytes: number | null; message_bytes: number;
      }[];
    const clear = db.prepare(`UPDATE adit_history_blocks AS b SET data_json=NULL WHERE b.id=? AND b.data_json IS NOT NULL
      AND EXISTS(SELECT 1 FROM adit_history_messages m WHERE m.id=b.message_id AND b.data_json=
        CASE WHEN json_valid(m.content_json) THEN CASE WHEN json_type(m.content_json)='array'
          THEN m.content_json -> ('$['||b.block_index||']') WHEN b.block_index=0 THEN m.content_json END END)`);
    const readRaw = db.prepare("SELECT raw_json,content_json FROM adit_history_messages WHERE id=? AND raw_content_paths_json IS NULL");
    const updateRaw = db.prepare("UPDATE adit_history_messages SET raw_json=?,raw_content_paths_json=? WHERE id=? AND raw_content_paths_json IS NULL");
    let processed = 0, bytes = 0;
    const started = performance.now();
    for (const row of rows) {
      const size = row.bytes === null ? 0 : row.bytes + row.message_bytes;
      if (processed && (bytes + size > 2 * 1024 * 1024 || performance.now() - started >= 25)) break;
      if (row.bytes !== null) {
        let removed = 0;
        if (size <= 16 * 1024 * 1024) {
          if (rawTask) {
            const message = readRaw.get(row.id) as { raw_json: string; content_json: string | null };
            const compacted = compactHistoryRaw(message.raw_json, message.content_json);
            if (compacted.pathsJson && updateRaw.run(compacted.rawJson, compacted.pathsJson, row.id).changes)
              removed = row.bytes - Buffer.byteLength(compacted.rawJson) - Buffer.byteLength(compacted.pathsJson);
          } else if (clear.run(row.id).changes) removed = row.bytes;
        }
        if (removed > 0) {
          progress.cleared++;
          progress.bytes_removed += removed;
        } else progress.skipped++;
      }
      bytes += size;
      processed++;
      progress.scanned++;
      progress.cursor = row.rowid;
    }
    progress.status = !rows.length || progress.cursor >= progress.upper_bound ? "done" : "running";
    progress.updated_at = Date.now();
    progress.error = null;
    db.prepare(`UPDATE adit_local_maintenance SET status=@status,cursor=@cursor,scanned=@scanned,
      cleared=@cleared,skipped=@skipped,bytes_removed=@bytes_removed,updated_at=@updated_at,error=NULL WHERE task=@task`).run(progress);
    return { progress };
  }).immediate();
}
