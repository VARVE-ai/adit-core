import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import type { LocalWorkspace } from "@varveai/adit-core";
import { cloudPending, type PendingSessionCache } from "./cloud-pending.js";
import { pendingRevision } from "./cloud-pending-schema.js";
import type { CloudBaseline } from "./cloud-projection.js";

if (parentPort) {
  const db = new Database(workerData.path, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout=1000");
  parentPort.on("message", ({ type, id, workspace, scope, sessions }: {
    type?: string; id: number; workspace: LocalWorkspace; scope: string;
    sessions: [string, { key: string; pending: boolean }][];
  }) => {
    if (type === "close") {
      db.close();
      parentPort!.close();
      return;
    }
    try {
      const result = db.transaction(() => {
        const revision = pendingRevision(db);
        const row = db.prepare("SELECT baseline FROM adit_local_cloud_scopes WHERE id=?").get(scope) as { baseline: string } | undefined;
        const cache: PendingSessionCache = new Map(sessions);
        const value = row ? cloudPending({ db }, workspace, scope, JSON.parse(row.baseline) as CloudBaseline, cache)
          : { state: "uninitialized", sessions: null, commits: null };
        return { revision, value, sessions: [...cache] };
      })();
      parentPort!.postMessage({ id, result });
    } catch (error) {
      parentPort!.postMessage({ id, error: error instanceof Error ? error.message : "Pending count unavailable" });
    }
  });
}
