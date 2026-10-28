import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { LocalInspection } from "@varveai/adit-core";
if (parentPort) {
  const db = new Database(workerData.path);
  db.pragma("busy_timeout=15000");
  db.pragma("foreign_keys=ON");
  const inspection = new LocalInspection(db);
  parentPort.on("message", async ({ type, id, runId, workspace, force }) => {
    if (type === "close") {
      db.close();
      parentPort!.close();
      return;
    }
    try {
      await inspection.run(workspace, runId, force);
      parentPort!.postMessage({ id });
    } catch {
      parentPort!.postMessage({ id, error: true });
    }
  });
}
