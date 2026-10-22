import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { LocalAnalytics, LocalStateError } from "@varveai/adit-core";

// All reads/temporary projections run off the daemon's HTTP/collection event loop.
if (parentPort) {
  const db = new Database(workerData.path);
  db.pragma("busy_timeout=5000");
  const analytics = new LocalAnalytics(db);
  parentPort.on("message", ({ id, workspace, options }) => {
    try {
      parentPort!.postMessage({
        id,
        result: analytics.overview(workspace, options),
      });
    } catch (error) {
      parentPort!.postMessage({
        id,
        error:
          error instanceof Error
            ? error.message
            : "Overview calculation failed",
        status: error instanceof LocalStateError ? error.status : 500,
      });
    }
  });
}
