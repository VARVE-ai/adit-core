import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { runMaintenanceBatch, type MaintenanceTask } from "./maintenance-tasks.js";

if (parentPort) {
  const db = new Database(workerData.path, { fileMustExist: true, timeout: 50 });
  db.pragma("foreign_keys=ON");
  db.pragma("cache_size=-2048");
  parentPort.on("message", ({ type, id, task }: { type?: string; id: number; task: MaintenanceTask }) => {
    if (type === "close") {
      db.close();
      parentPort!.close();
      return;
    }
    try {
      parentPort!.postMessage({ id, result: runMaintenanceBatch(db, task) });
    } catch (error) {
      if ((error as { code?: string }).code?.startsWith("SQLITE_BUSY")) parentPort!.postMessage({ id, result: { paused: true } });
      else parentPort!.postMessage({ id, error: "Local maintenance failed" });
    }
  });
}
