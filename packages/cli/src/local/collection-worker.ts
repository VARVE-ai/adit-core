import { parentPort, workerData } from "node:worker_threads";
import { LocalHistory, LocalStore } from "@varveai/adit-core";
import type { CollectionScanRequest } from "./collection-scan.js";

if (parentPort) {
  const request = workerData as CollectionScanRequest;
  let store: LocalStore | undefined;
  try {
    store = new LocalStore(request.directory);
    store.db.pragma("busy_timeout=15000");
    const history = new LocalHistory(store.db, {discovery: !request.workspace});
    const unchanged = (id?: string) => {
      for (const workspace of request.workspaces ?? (request.workspace ? [request.workspace] : []))
        if (store!.workspace(workspace.id).version !== workspace.version)
          throw new Error("Settings changed; retry with the saved selection");
      if (
        id &&
        store!.provider(id).version !==
          request.sources.find((s) => s.id === id)!.version
      )
        throw new Error(
          "Source settings changed; retry with the saved selection",
        );
    };
    unchanged();
    let lastProgress=0;
    const result = await history.scan(request.path, request.sources, {
      preview: !request.workspace,
      scopes: request.workspaces,
      beforeSource: unchanged,
      sourceProgress:(scope,provider,progress)=>{
        for(const job of request.jobs??[request.job]) {
          const workspace=(request.workspaces??(request.workspace?[request.workspace]:[])).find(w=>w.id===job.workspaceId);
          if(workspace?.path!==scope)continue;
          job.sourceProgress??={};job.sourceProgress[provider]=progress;
        }
        if(progress.status!=="running"||Date.now()-lastProgress>=250){lastProgress=Date.now();for(const job of request.jobs??[request.job])store!.job(job);}
      },
      progress: (files, updated) => {
        if(Date.now()-lastProgress<250)return;
        lastProgress=Date.now();
        // Persist on the writer thread: an HTTP-thread progress write could
        // otherwise wait for the next transcript's SQLite write lock.
        for (const job of request.jobs ?? [request.job]) {
          job.progress = { files, updated };
          store!.job(job);
        }
      },
    });
    unchanged();
    for(const job of request.jobs ?? [request.job]){
      job.progress={files:result.scanned,updated:result.updated};store.job(job);
    }
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({
      error: error instanceof Error ? error.message : "Collection failed",
    });
  } finally {
    store?.close();
    parentPort.close();
  }
}
