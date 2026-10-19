import { parentPort, workerData } from "node:worker_threads";
import { LocalStore } from "@varveai/adit-core";
import { analyzeAttribution } from "./attribution-analysis.js";
if (parentPort) {
  const store = new LocalStore(workerData.directory);
  store.db.pragma("busy_timeout=10000");
  let queue = Promise.resolve();
  parentPort.on("message", ({ id, workspace }) => {
    queue = queue.then(async () => {
      try {
        const result = await analyzeAttribution(store, workspace);
        parentPort!.postMessage({ id, result });
      } catch (error) {
        parentPort!.postMessage({
          id,
          error: error instanceof Error ? error.message : "Analysis failed",
        });
      }
    });
  });
}
