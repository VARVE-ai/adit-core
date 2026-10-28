import { parentPort, workerData } from "node:worker_threads";
import { LocalStore } from "@varveai/adit-core";
import { analyzeAttribution } from "./attribution-analysis.js";
if (parentPort) {
  const store = new LocalStore(workerData.directory);
  store.db.pragma("busy_timeout=10000");
  let queue = Promise.resolve();
  parentPort.on("message", ({ type, id, workspace, job }) => {
    if (type === "close") {
      queue = queue.then(() => {
        store.close();
        parentPort!.close();
      });
      return;
    }
    queue = queue.then(async () => {
      try {
        const result = await analyzeAttribution(store, workspace,{progress:repository=>{
          if(job&&job.activeRepository!==repository){job.activeRepository=repository;store.job(job);}
        }});
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
