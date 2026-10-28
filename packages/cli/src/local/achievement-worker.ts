import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { LocalAchievements } from "@varveai/adit-core";
if (parentPort) {
  const db = new Database(workerData.path);
  db.pragma("busy_timeout=15000");
  db.pragma("foreign_keys=ON");
  const achievements = new LocalAchievements(db);
  parentPort.on("message", ({ type, id, workspace, sourceErrors }) => {
    if (type === "close") {
      db.close();
      parentPort!.close();
      return;
    }
    try {
      achievements.evaluate(workspace, { sourceErrors });
      parentPort!.postMessage({ id });
    } catch {
      parentPort!.postMessage({
        id,
        error: "Achievement evaluation failed; previous results retained",
      });
    }
  });
}
